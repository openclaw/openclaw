import fs from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as avatarFile from "../agents/identity-avatar-file.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  stageSessionPendingInput,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { discardSessionPendingInput } from "../config/sessions/session-pending-input-withdrawal.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as devInstallBranch from "../infra/dev-install-branch.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-contract.js";
import {
  handleControlUiAssistantMediaRequest,
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
} from "./control-ui.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const testTempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

function createAvatarConfig(workspace: string, avatar: string): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace },
      entries: { main: { workspace, identity: { avatar } } },
    },
  };
}

describe("Control UI response authority", () => {
  it("briefly caches an authenticated missing agent avatar", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = createAvatarConfig(state.workspaceDir, "missing.png");
      setRuntimeConfigSnapshot(config);
      const req = new IncomingMessage(new Socket());
      Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
      req.method = "GET";
      req.url = "/avatar/main";
      req.headers = { authorization: "Bearer admitted-token" };
      const res = new ServerResponse(req);
      const handled = await handleControlUiAvatarRequest(req, res, {
        config,
        cfg: config,
        auth: { mode: "token", token: "admitted-token", allowTailscale: false },
      });
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
      expect(res.getHeader("Cache-Control")).toBe("private, max-age=60");
      expect(res.getHeader("Vary")).toBe("Authorization, Cookie");
    });
  });

  it("withholds prepared bootstrap bytes when visitor authority expires before its abort signal", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const trustedProxy = { userHeader: "x-visitor-email", allowLoopback: true };
      const config: OpenClawConfig = {
        gateway: {
          auth: { mode: "trusted-proxy", trustedProxy },
          trustedProxies: ["127.0.0.1"],
        },
      };
      const auth: ResolvedGatewayAuth = {
        mode: "trusted-proxy",
        trustedProxy,
        allowTailscale: false,
      };
      setRuntimeConfigSnapshot(config);
      ensureProfileForEmail("visitor@example.test");
      const grant = new AbortController();
      const expiresAt = 1_000;
      let now = 0;
      const { registry } = createPluginRegistryFixture(config);
      registerVirtualTestPlugin({
        registry,
        config,
        id: "person-access",
        name: "Person access",
        register(api) {
          api.registerGatewayAccessPolicy({
            authorize: () => ({
              signal: grant.signal,
              assertCurrent() {
                grant.signal.throwIfAborted();
                if (now >= expiresAt) {
                  throw new Error("Visitor grant expired");
                }
              },
            }),
          });
          api.registerHttpRoute({
            path: "/secure-hook",
            auth: "gateway",
            match: "prefix",
            handler: async () => true,
          });
          api.session.controls.registerControlUiDescriptor({
            surface: "tab",
            id: "panel",
            label: "Visitor panel",
            path: "/secure-hook/panel",
          });
        },
      });
      setActivePluginRegistry(registry.registry);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      vi.spyOn(devInstallBranch, "resolveDevInstallGitBranch").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return "private-branch";
      });
      const req = new IncomingMessage(new Socket());
      Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
      req.method = "GET";
      req.url = CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
      req.headers = {
        "x-visitor-email": "visitor@example.test",
        "x-forwarded-for": "203.0.113.10",
        "x-openclaw-scopes": "operator.read",
      };
      const res = new ServerResponse(req);
      const end = vi.spyOn(res, "end");
      const catalog = await prepareUserProfileCatalog();
      const pending = handleControlUiHttpRequest(req, res, {
        config,
        cfg: config,
        auth,
        trustedProxies: config.gateway?.trustedProxies,
        getResolvedAuth: () => auth,
        getRuntimeConfig: () => config,
      });
      const settled = pending.catch((error: unknown) => error);
      try {
        await Promise.race([entered.promise, pending]);
        expect(res.getHeader("Set-Cookie")).toEqual(
          expect.arrayContaining([expect.stringContaining("Path=/secure-hook")]),
        );
        now = expiresAt;
        expect(grant.signal.aborted).toBe(false);
        release.resolve();

        expect(await settled).toBeInstanceOf(Error);
        expect(res.destroyed).toBe(true);
        expect(res.headersSent).toBe(false);
        expect(end).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await settled;
        res.destroy();
        req.destroy();
        catalog.release();
      }
    });
  });

  it.each(["avatar", "bootstrap"] as const)(
    "withholds a prepared %s response after requester authority changes",
    async (kind) => {
      const workspace = testTempDirs.make("openclaw-ui-response-authority-");
      await fs.writeFile(path.join(workspace, "avatar.png"), REAL_PNG);
      let config = createAvatarConfig(workspace, "avatar.png");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      if (kind === "bootstrap") {
        const registry = createEmptyPluginRegistry();
        registry.controlUiDescriptors.push({
          pluginId: "demo-plugin",
          source: "demo-plugin",
          descriptor: {
            surface: "tab",
            id: "demo",
            label: "Demo",
            path: "/secure-hook/panel",
          },
        });
        registry.httpRoutes.push({
          pluginId: "demo-plugin",
          source: "demo-plugin",
          path: "/secure-hook",
          auth: "gateway",
          match: "prefix",
          handler: async () => true,
        });
        setActivePluginRegistry(registry);
        vi.spyOn(devInstallBranch, "resolveDevInstallGitBranch").mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return "private-branch";
        });
      } else {
        const prepare = avatarFile.prepareLocalAgentAvatarFile;
        vi.spyOn(avatarFile, "prepareLocalAgentAvatarFile").mockImplementation(async (params) => {
          const prepared = await prepare(params);
          expect(prepared).toMatchObject({ ok: true, file: { body: REAL_PNG } });
          entered.resolve();
          await release.promise;
          return prepared;
        });
      }
      let auth: ResolvedGatewayAuth = {
        mode: "token",
        token: "admitted-token",
        allowTailscale: false,
      };
      const req = new IncomingMessage(new Socket());
      Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
      req.method = "GET";
      req.url = kind === "bootstrap" ? CONTROL_UI_BOOTSTRAP_CONFIG_PATH : "/avatar/main";
      req.headers = { authorization: "Bearer admitted-token" };
      const res = new ServerResponse(req);
      const end = vi.spyOn(res, "end");
      const setHeader = vi.spyOn(res, "setHeader");
      const handler =
        kind === "bootstrap" ? handleControlUiHttpRequest : handleControlUiAvatarRequest;
      const pending = handler(req, res, {
        config,
        cfg: config,
        auth,
        getResolvedAuth: () => auth,
        getRuntimeConfig: () => config,
      });
      const settled = pending.catch(() => undefined);
      try {
        await Promise.race([entered.promise, pending]);
        expect(res.writableEnded).toBe(false);
        if (kind === "bootstrap") {
          expect(res.getHeader("Set-Cookie")).toEqual(
            expect.arrayContaining([expect.stringContaining("Path=/secure-hook")]),
          );
          config = { ...config, gateway: { roles: { definitions: {} } } };
        } else {
          auth = { ...auth, token: "replacement-token" };
        }
      } finally {
        release.resolve();
        await settled;
      }

      expect(res.statusCode).toBe(401);
      expect(String(end.mock.calls[0]?.[0])).not.toContain("private-branch");
      expect(end).not.toHaveBeenCalledWith(REAL_PNG);
      expect(setHeader).not.toHaveBeenCalledWith("Content-Type", "image/png");
      expect(setHeader).not.toHaveBeenCalledWith("ETag", expect.anything());
      expect(res.getHeader("Set-Cookie")).toBeUndefined();
    },
  );
});

describe("saved message attachment response authority", () => {
  const email = "attachment-reader@example.test";
  const adminEmail = "attachment-admin@example.test";
  const viewerEmail = "attachment-viewer@example.test";
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:attachments",
    sessionId: "attachments",
  };
  const source = "media://inbound/selection-comment.txt";
  const text = "Saved selection comment";
  const cronProvenance = {
    kind: "inter_session",
    sourceTool: "sessions_send",
    sourceSessionKey: "agent:main:cron:daily-report:run:completed-run",
  } as const;
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let listener: Awaited<
    ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>
  >;
  let origin: string;
  let profileId: string;
  let adminId: string;
  let ordinary: string;
  let config: OpenClawConfig;

  async function seed(commentSource = source) {
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "comment",
        parentId: null,
        message: {
          role: "user",
          content: "Please check the selected text.",
          __openclaw: {
            media: [
              { url: commentSource, fileName: "selection-comment.txt", contentType: "text/plain" },
            ],
          },
        },
      },
      {
        type: "message",
        id: "ordinary",
        parentId: "comment",
        message: {
          role: "assistant",
          content: [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "notes.txt",
                url: ordinary,
                mimeType: "text/plain",
              },
            },
          ],
        },
      },
      {
        type: "message",
        id: "legacy-media",
        parentId: "ordinary",
        message: {
          role: "assistant",
          content: `Saved report\nMEDIA:${path.join(state.workspaceDir, "report.txt")}`,
        },
      },
      {
        type: "message",
        id: "user-directive",
        parentId: "legacy-media",
        message: {
          role: "user",
          content: `MEDIA:${path.join(state.workspaceDir, "report.txt")}`,
        },
      },
      {
        type: "message",
        id: "text-only",
        parentId: "user-directive",
        message: {
          role: "user",
          content: source,
        },
      },
      {
        type: "message",
        id: "hidden",
        parentId: "text-only",
        message: {
          role: "user",
          content: "Internal coordination",
          idempotencyKey: "coordination:user",
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceRole: "subagent",
          },
          __openclaw: { media: [{ url: source }] },
        },
      },
      {
        type: "message",
        id: "cron-forwarded",
        parentId: "hidden",
        message: {
          role: "user",
          content: "Scheduled report",
          provenance: cronProvenance,
          __openclaw: { media: [{ url: source, contentType: "text/plain" }] },
        },
      },
    ]);
  }

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal", label: "message-attachments" });
    const trustedProxy = { userHeader: "x-forwarded-user", allowLoopback: true };
    config = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      tools: { fs: { workspaceOnly: true } },
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy },
        trustedProxies: ["127.0.0.1"],
        roles: {
          default: "guest",
          definitions: {
            guest: {
              agents: ["main"],
              sessions: { others: "none" },
              scopes: ["operator.sessions.read"],
            },
            viewer: {
              agents: ["main"],
              sessions: { others: "view" },
              scopes: ["operator.sessions.read"],
            },
            admin: { agents: "*", sessions: { others: "write" }, scopes: ["operator.admin"] },
          },
        },
      },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config, config);
    profileId = (await ensureCanonicalUserProfileForEmail(email)).id;
    adminId = (await ensureCanonicalUserProfileForEmail(adminEmail)).id;
    const viewerId = (await ensureCanonicalUserProfileForEmail(viewerEmail)).id;
    await setCanonicalUserProfileRole(viewerId, "viewer", {
      onCommitted: invalidateOperatorRolePolicy,
    });
    await setCanonicalUserProfileRole(adminId, "admin", {
      onCommitted: invalidateOperatorRolePolicy,
    });
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: profileId },
      visibility: "shared",
    });
    ordinary = "media://inbound/notes.txt";
    await seed();
    await fs.mkdir(state.statePath("media", "inbound"), { recursive: true });
    await fs.writeFile(state.statePath("media", "inbound", "selection-comment.txt"), text);
    await fs.writeFile(state.statePath("media", "inbound", "notes.txt"), "Ordinary attachment");
    await fs.writeFile(path.join(state.workspaceDir, "report.txt"), "Saved assistant report");
    listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          void handleControlUiAssistantMediaRequest(req, res, {
            config,
            cfg: config,
            getRuntimeConfig: () => config,
            auth: { mode: "trusted-proxy", trustedProxy, allowTailscale: false },
            trustedProxies: ["127.0.0.1"],
          }).catch((error: unknown) => {
            res.statusCode = 500;
            res.end(String(error));
          });
        }),
    });
    origin = `http://127.0.0.1:${listener.claim.port}`;
  });

  afterAll(async () => {
    await listener?.releaseListener();
    await listener?.claim.release();
    await state?.cleanup();
  });

  function request(
    query: Record<string, string>,
    options: {
      ticketOnly?: boolean;
      admin?: boolean;
      viewer?: boolean;
      method?: string;
      range?: string;
    } = {},
  ) {
    const params = new URLSearchParams({
      source,
      sessionKey: scope.sessionKey,
      agentId: "main",
      messageId: "comment",
      ...query,
    });
    return fetch(`${origin}/__openclaw__/assistant-media?${params}`, {
      method: options.method,
      headers: {
        ...(options.ticketOnly
          ? {}
          : {
              "x-forwarded-user": options.admin ? adminEmail : options.viewer ? viewerEmail : email,
              "x-forwarded-for": "203.0.113.42",
              "x-openclaw-scopes": options.admin ? "operator.admin" : "operator.sessions.read",
            }),
        ...(options.range ? { Range: options.range } : {}),
      },
    });
  }

  async function metadata(
    query: Record<string, string> = {},
    options: Parameters<typeof request>[1] = {},
  ) {
    const response = await request({ ...query, meta: "1" }, options);
    expect(
      response.status,
      `${query.messageId ?? "comment"}: ${await response.clone().text()}`,
    ).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ available: true });
    expect(result.mediaTicket).toEqual(expect.any(String));
    return String(result.mediaTicket);
  }

  it("reads saved comments and ordinary attachments through metadata, preview, download and renewal", async () => {
    for (const [messageId, file, expected] of [
      ["comment", source, text],
      ["ordinary", ordinary, "Ordinary attachment"],
      ["cron-forwarded", source, text],
    ]) {
      const query = { source: file!, messageId: messageId! };
      const mediaTicket = await metadata(query);
      const direct = await request(query);
      expect(direct.status).toBe(200);
      expect(await direct.text()).toBe(expected);
      const ticketed = { ...query, mediaTicket };
      const preview = await request(ticketed, { ticketOnly: true });
      expect(preview.status).toBe(200);
      expect(await preview.text()).toBe(expected);
      expect(preview.headers.get("content-disposition")).toContain("attachment;");
      const head = await request(ticketed, { ticketOnly: true, method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(expected!.length));
      const range = await request(ticketed, { ticketOnly: true, range: "bytes=0-4" });
      expect(range.status).toBe(206);
      expect(await range.text()).toBe(expected!.slice(0, 5));
      await metadata(ticketed);
    }
  });

  it("rejects unrelated sources, inaccessible messages and ticket substitutions without changing standalone admin reads", async () => {
    const mediaTicket = await metadata();
    const substitutions: [Record<string, string>, number][] = [
      [{ source: ordinary }, 401],
      [{ messageId: "missing" }, 404],
      [{ messageId: "text-only" }, 404],
      [{ messageId: "hidden" }, 404],
      [{ sessionKey: "agent:main:dashboard:missing" }, 404],
    ];
    for (const [query, ticketStatus] of substitutions) {
      expect((await request({ ...query, meta: "1" })).status).toBe(404);
      expect((await request({ ...query, mediaTicket }, { ticketOnly: true })).status).toBe(
        ticketStatus,
      );
    }
    expect((await request({ messageId: "", meta: "1" })).status).toBe(403);
    const standalone = await request(
      { sessionKey: "", messageId: "", source, meta: "1" },
      { admin: true },
    );
    expect(standalone.status).toBe(200);
    expect(await standalone.json()).toMatchObject({ available: true });
    const outside = path.join(state.root, "outside.txt");
    await fs.writeFile(outside, "Not in an allowed directory");
    const escapingSource = "media://inbound/escaping.txt";
    await fs.symlink(outside, state.statePath("media", "inbound", "escaping.txt"));
    await seed(escapingSource);
    try {
      const denied = await request({ source: escapingSource, meta: "1" });
      expect(denied.status).toBe(200);
      expect(await denied.json()).toMatchObject({ available: false });
      expect((await request({ source: escapingSource })).status).toBe(404);
    } finally {
      await seed();
    }
  });

  it("reads saved assistant media directives without treating user text as an attachment", async () => {
    const query = {
      source: path.join(state.workspaceDir, "report.txt"),
      messageId: "legacy-media",
    };
    const mediaTicket = await metadata(query);
    const response = await request({ ...query, mediaTicket }, { ticketOnly: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Saved assistant report");
    expect((await request({ ...query, messageId: "user-directive", meta: "1" })).status).toBe(404);
  });

  it("reads queued and stopped inputs, including automation, and withholds bytes after withdrawal", async () => {
    for (const [stopped, forwarded] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const runId = `attachment-pending-${stopped}-${forwarded}`;
      const receipt = await stageSessionPendingInput(scope, {
        runId,
        assertCurrent: () => {},
        message: {
          role: "user",
          content: "Saved pending comment",
          timestamp: 1,
          idempotencyKey: `${runId}:user`,
          ...(forwarded ? { provenance: cronProvenance } : {}),
          __openclaw: { media: [{ url: source, contentType: "text/plain" }] },
        },
      });
      expect(receipt).toBeDefined();
      try {
        if (stopped) {
          receipt!.finish("cancelled");
          await receipt!.settled?.();
        }
        const query = { messageId: `pending:${receipt!.inputId}` };
        const mediaTicket = await metadata(query);
        const preview = await request({ ...query, mediaTicket }, { ticketOnly: true });
        expect(preview.status).toBe(200);
        expect(await preview.text()).toBe(text);
        const file = state.statePath("media", "inbound", "selection-comment.txt");
        const open = fs.open;
        let withdrawn = false;
        const spy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
          const handle = await open(filePath, flags, mode);
          if (filePath === file && !withdrawn) {
            withdrawn = await discardSessionPendingInput(scope, runId, () => {});
          }
          return handle;
        });
        try {
          const response = await request({ ...query, mediaTicket }, { ticketOnly: true });
          expect(withdrawn).toBe(true);
          expect(response.status).toBe(404);
          expect(await response.text()).not.toContain(text);
          expect((await request({ ...query, meta: "1" })).status).toBe(404);
        } finally {
          spy.mockRestore();
        }
      } finally {
        receipt!.finish("cancelled");
        await receipt!.settled?.();
      }
    }
  });

  it("rechecks session and role access for issued tickets and metadata refresh", async () => {
    const mediaTicket = await metadata({}, { viewer: true });
    await upsertSessionEntryCore(scope, { visibility: "draft" });
    try {
      expect((await request({ mediaTicket }, { ticketOnly: true })).status).toBe(404);
      expect((await request({ mediaTicket, meta: "1" }, { viewer: true })).status).toBe(404);
    } finally {
      await upsertSessionEntryCore(scope, { visibility: "shared" });
    }
    const ownTicket = await metadata();
    const before = config;
    config = {
      ...config,
      gateway: {
        ...config.gateway,
        roles: {
          ...config.gateway!.roles,
          definitions: {
            ...config.gateway!.roles!.definitions,
            guest: { agents: ["main"], sessions: { others: "none" }, scopes: [] },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config, config);
    try {
      expect((await request({ mediaTicket: ownTicket }, { ticketOnly: true })).status).toBe(404);
      expect((await request({ mediaTicket: ownTicket, meta: "1" })).status).toBe(403);
    } finally {
      config = before;
      setRuntimeConfigSnapshot(config, config);
    }
  });

  it("withholds prepared bytes and old tickets when a saved attachment association is replaced", async () => {
    const mediaTicket = await metadata();
    const file = state.statePath("media", "inbound", "selection-comment.txt");
    const open = fs.open;
    let changed = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await open(filePath, flags, mode);
      if (filePath === file && !changed) {
        changed = true;
        await seed(ordinary);
      }
      return handle;
    });
    try {
      const response = await request({ mediaTicket }, { ticketOnly: true });
      expect(changed).toBe(true);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(text);
      expect((await request({ mediaTicket }, { ticketOnly: true })).status).toBe(404);
    } finally {
      spy.mockRestore();
      await seed();
    }
  });
});
