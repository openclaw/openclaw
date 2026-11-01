import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as avatarFile from "../agents/identity-avatar-file.js";
import { mockStoppedWorkspaceContainer } from "../agents/sandbox/mount-plan.test-helpers.js";
import { requireGit } from "../agents/worktrees/git.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { makeWorktreeRecord } from "../agents/worktrees/service.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  stageSessionPendingInput,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { discardSessionPendingInput } from "../config/sessions/session-pending-input-withdrawal.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as devInstallBranch from "../infra/dev-install-branch.js";
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
import { invalidateOperatorRolePolicy, resolveCreatorSandbox } from "./operator-role-policy.js";
import { withLocalWorkspaceProjection } from "./worker-environments/local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "./worker-environments/local-workspace-types.js";

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

const tokenAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "admitted-token",
  allowTailscale: false,
};

function httpResponse(
  url: string,
  headers: Record<string, string> = { authorization: "Bearer admitted-token" },
) {
  const req = new IncomingMessage(new Socket());
  Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
  Object.assign(req, { method: "GET", url, headers });
  const res = new ServerResponse(req);
  return { req, res };
}

function registerPanel(
  config: OpenClawConfig,
  grant?: { signal: AbortSignal; assertCurrent(): void },
) {
  const { registry } = createPluginRegistryFixture(config);
  registerVirtualTestPlugin({
    registry,
    config,
    id: "person-access",
    name: "Person access",
    register(api) {
      if (grant) {
        api.registerGatewayAccessPolicy({ authorize: () => grant });
      }
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
}

function preparationGate() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    entered,
    release,
    async hold<T>(this: void, value: T) {
      entered.resolve();
      await release.promise;
      return value;
    },
  };
}

describe("Control UI response authority", () => {
  it("briefly caches an authenticated missing agent avatar", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = createAvatarConfig(state.workspaceDir, "missing.png");
      setRuntimeConfigSnapshot(config);
      const { req, res } = httpResponse("/avatar/main");
      const handled = await handleControlUiAvatarRequest(req, res, {
        config,
        cfg: config,
        auth: tokenAuth,
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
      registerPanel(config, {
        signal: grant.signal,
        assertCurrent() {
          grant.signal.throwIfAborted();
          if (now >= expiresAt) {
            throw new Error("Visitor grant expired");
          }
        },
      });
      const { entered, release, hold } = preparationGate();
      vi.spyOn(devInstallBranch, "resolveDevInstallGitBranch").mockImplementation(() =>
        hold("private-branch"),
      );
      const { req, res } = httpResponse(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, {
        "x-visitor-email": "visitor@example.test",
        "x-forwarded-for": "203.0.113.10",
        "x-openclaw-scopes": "operator.read",
      });
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
        expect(res).toMatchObject({ destroyed: true, headersSent: false });
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
      const { entered, release, hold } = preparationGate();
      if (kind === "bootstrap") {
        registerPanel(config);
        vi.spyOn(devInstallBranch, "resolveDevInstallGitBranch").mockImplementation(() =>
          hold("private-branch"),
        );
      } else {
        const prepare = avatarFile.prepareLocalAgentAvatarFile;
        vi.spyOn(avatarFile, "prepareLocalAgentAvatarFile").mockImplementation(async (params) => {
          const prepared = await prepare(params);
          expect(prepared).toMatchObject({ ok: true, file: { body: REAL_PNG } });
          return hold(prepared);
        });
      }
      let auth = tokenAuth;
      const { req, res } = httpResponse(
        kind === "bootstrap" ? CONTROL_UI_BOOTSTRAP_CONFIG_PATH : "/avatar/main",
      );
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
  const unrelatedEmail = "attachment-unrelated@example.test";
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
  const ordinary = "media://inbound/notes.txt";
  let config: OpenClawConfig;
  let workspaceDir: string;
  let projection: string;
  let owner: LocalWorkspaceOwner;

  beforeEach(async () => {
    await mockStoppedWorkspaceContainer(projection);
  });

  async function seed(commentSource = source) {
    const directive = `MEDIA:${path.join(workspaceDir, "report.txt")}`;
    let parentId: string | null = null;
    function message(id: string, content: unknown, extra: Record<string, unknown> = {}) {
      const event = { type: "message", id, parentId, message: { role: "user", content, ...extra } };
      parentId = id;
      return event;
    }
    function media(url: string, fields: Record<string, string> = {}) {
      return { __openclaw: { media: [{ url, ...fields }] } };
    }
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      message("comment", "Please check the selected text.", media(commentSource)),
      message("ordinary", [{ type: "attachment", attachment: { url: ordinary } }], {
        role: "assistant",
      }),
      message("legacy-media", `Saved report\n${directive}`, { role: "assistant" }),
      message("sandbox-screenshot", "MEDIA:/workspace/.artifacts/proof/screenshot.png", {
        role: "assistant",
      }),
      message("relative-screenshot", "MEDIA:.artifacts/proof/screenshot.png", {
        role: "assistant",
      }),
      message("host-image", `MEDIA:${path.join(state.root, "outside.png")}`, { role: "assistant" }),
      message("workspace-image", `MEDIA:${path.join(workspaceDir, "inside.png")}`, {
        role: "assistant",
      }),
      message("user-directive", directive),
      message("text-only", source),
      message("hidden", "Internal coordination", {
        idempotencyKey: "coordination:user",
        provenance: { kind: "inter_session", sourceTool: "sessions_send", sourceRole: "subagent" },
        ...media(source),
      }),
      message("cron-forwarded", "Scheduled report", {
        provenance: cronProvenance,
        ...media(source, { contentType: "text/plain" }),
      }),
    ]);
  }

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal", label: "message-attachments" });
    const repo = state.workspaceDir;
    workspaceDir = path.join(state.root, "checkout");
    await requireGit(repo, ["init", "--quiet", "-b", "main"]);
    await requireGit(repo, ["config", "user.name", "Test"]);
    await requireGit(repo, ["config", "user.email", "test@example.invalid"]);
    await fs.writeFile(path.join(repo, ".gitignore"), ".artifacts/\n");
    await requireGit(repo, ["add", ".gitignore"]);
    await requireGit(repo, ["commit", "--quiet", "-m", "base"]);
    await requireGit(repo, ["worktree", "add", "--quiet", "-b", "screenshot", workspaceDir]);
    owner = {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      lifecycleRevision: null,
      assertCurrent() {},
      worktree: makeWorktreeRecord(repo, randomUUID(), {
        name: "screenshots",
        repoFingerprint: "test",
        path: workspaceDir,
        branch: "screenshot",
        baseRef: "main",
        ownerId: scope.sessionKey,
        createdAt: 0,
        lastActiveAt: 0,
      }),
    };
    await insertRegistryWorktree(process.env, owner.worktree);
    const trustedProxy = { userHeader: "x-forwarded-user", allowLoopback: true };
    config = {
      agents: { entries: { main: { workspace: workspaceDir } } },
      tools: { fs: { workspaceOnly: true } },
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy },
        trustedProxies: ["127.0.0.1"],
        roles: {
          default: "guest",
          definitions: {
            guest: { ...readerRole("none"), sandbox: "required" },
            viewer: readerRole("view"),
            admin: { agents: "*", sessions: { others: "write" }, scopes: ["operator.admin"] },
          },
        },
      },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config, config);
    const profileId = (await ensureCanonicalUserProfileForEmail(email)).id;
    await ensureCanonicalUserProfileForEmail(unrelatedEmail);
    for (const [address, role] of [
      [viewerEmail, "viewer"],
      [adminEmail, "admin"],
    ] as const) {
      const { id } = await ensureCanonicalUserProfileForEmail(address);
      await setCanonicalUserProfileRole(id, role, { onCommitted: invalidateOperatorRolePolicy });
    }
    const catalog = await prepareUserProfileCatalog();
    let sandbox: "required" | undefined;
    try {
      sandbox = resolveCreatorSandbox(config, {
        actor: { type: "human", source: "profile", id: profileId },
      });
      expect(sandbox).toBe("required");
    } finally {
      catalog.release();
    }
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: profileId },
      visibility: "shared",
      sandbox,
      spawnedCwd: workspaceDir,
      spawnedWorkspaceDir: workspaceDir,
      worktree: {
        id: owner.worktree.id,
        branch: owner.worktree.branch,
        repoRoot: owner.worktree.repoRoot,
      },
    });
    await seed();
    await fs.mkdir(state.statePath("media", "inbound"), { recursive: true });
    await fs.writeFile(state.statePath("media", "inbound", "selection-comment.txt"), text);
    await fs.writeFile(state.statePath("media", "inbound", "notes.txt"), "Ordinary attachment");
    await fs.writeFile(path.join(workspaceDir, "report.txt"), "Saved assistant report");
    await fs.writeFile(path.join(state.root, "outside.png"), REAL_PNG);
    await fs.writeFile(path.join(workspaceDir, "inside.png"), REAL_PNG);
    projection = await withLocalWorkspaceProjection(owner, (current) => current.prepare());
    await fs.mkdir(path.join(projection, ".artifacts", "proof"), { recursive: true });
    await fs.writeFile(path.join(projection, ".artifacts", "proof", "screenshot.png"), REAL_PNG);
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
          })
            .then((handled) => {
              if (!handled) {
                res.statusCode = 404;
                res.end();
              }
            })
            .catch((error: unknown) => {
              res.statusCode = 500;
              res.end(String(error));
            });
        }),
    });
    origin = `http://127.0.0.1:${listener.claim.port}`;
  });

  function readerRole(
    others: "none" | "view",
    scopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.sessions.read"],
  ): GatewayOperatorRoleDefinition {
    return { agents: ["main"], sessions: { others }, scopes };
  }

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
      unrelated?: boolean;
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
              "x-forwarded-user": options.unrelated
                ? unrelatedEmail
                : options.admin
                  ? adminEmail
                  : options.viewer
                    ? viewerEmail
                    : email,
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
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ available: true, mediaTicket: expect.any(String) });
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
      expect([direct.status, await direct.text()]).toEqual([200, expected]);
      const ticketed = { ...query, mediaTicket };
      const preview = await request(ticketed, { ticketOnly: true });
      expect([preview.status, await preview.text()]).toEqual([200, expected]);
      expect(preview.headers.get("content-disposition")).toContain("attachment;");
      const head = await request(ticketed, { ticketOnly: true, method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(expected!.length));
      const range = await request(ticketed, { ticketOnly: true, range: "bytes=0-4" });
      expect([range.status, await range.text()]).toEqual([206, expected!.slice(0, 5)]);
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

  it("previews unsynchronized sandbox screenshots with their original message and ticket identity", async () => {
    await expect(
      fs.stat(path.join(workspaceDir, ".artifacts", "proof", "screenshot.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const [messageId, imageSource] of [
      ["sandbox-screenshot", "/workspace/.artifacts/proof/screenshot.png"],
      ["relative-screenshot", ".artifacts/proof/screenshot.png"],
    ] as const) {
      const query = { source: imageSource, messageId };
      const mediaTicket = await metadata(query);
      const payload = Buffer.from(mediaTicket.split(".")[1]!, "base64url").toString("utf8");
      expect(JSON.parse(payload)).toMatchObject({
        source: "/workspace/.artifacts/proof/screenshot.png",
      });
      expect(payload).not.toContain(workspaceDir);
      const preview = await request({ ...query, mediaTicket }, { ticketOnly: true });
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(REAL_PNG);
    }
  });

  it.each([undefined, "full"] as const)(
    "contains required-sandbox conversation images with permission mode %s",
    async (permissionMode) => {
      const before = config;
      config = { ...config, tools: {} };
      setRuntimeConfigSnapshot(config, config);
      await upsertSessionEntryCore(scope, { permissionMode });
      try {
        const outside = { source: path.join(state.root, "outside.png"), messageId: "host-image" };
        const denied = await request({ ...outside, meta: "1" });
        expect(denied.status).toBe(200);
        expect(await denied.json()).toMatchObject({
          available: false,
          code: "outside-allowed-folders",
        });
        expect((await request(outside)).status).toBe(404);
        expect(
          (await request({ ...outside, meta: "1", allow: "1" }, { method: "POST" })).status,
        ).toBe(403);
        expect((await request({ ...outside, sessionKey: "", messageId: "" })).status).toBe(403);

        const inside = {
          source: path.join(workspaceDir, "inside.png"),
          messageId: "workspace-image",
        };
        const mediaTicket = await metadata(inside);
        const preview = await request({ ...inside, mediaTicket }, { ticketOnly: true });
        expect(preview.status).toBe(200);
        expect(Buffer.from(await preview.arrayBuffer())).toEqual(REAL_PNG);
        await metadata();
      } finally {
        config = before;
        setRuntimeConfigSnapshot(config, config);
        await upsertSessionEntryCore(scope, { permissionMode: undefined });
      }
    },
  );

  it("withholds relative screenshot aliases when workspace backing is obscured", async () => {
    const query = {
      source: ".artifacts/proof/screenshot.png",
      messageId: "relative-screenshot",
    };
    const mediaTicket = await metadata(query);
    await mockStoppedWorkspaceContainer(projection, "/workspace", [
      { Type: "tmpfs", Destination: "/workspace/.artifacts", RW: true },
    ]);
    const denied = await request({ ...query, meta: "1" });
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({ available: false });
    for (const [imageSource, ticketStatus] of [
      [query.source, 404],
      ["/workspace/.artifacts/proof/screenshot.png", 404],
      // A virtual-path ticket cannot authenticate a host-path request.
      [path.join(workspaceDir, ".artifacts", "proof", "screenshot.png"), 401],
    ] as const) {
      const imageQuery = { ...query, source: imageSource };
      expect((await request(imageQuery)).status).toBe(404);
      const ticketResponse = await request({ ...imageQuery, mediaTicket }, { ticketOnly: true });
      expect(ticketResponse.status).toBe(ticketStatus);
    }
  });

  it("reads saved assistant media directives without treating user text as an attachment", async () => {
    const query = {
      source: path.join(workspaceDir, "report.txt"),
      messageId: "legacy-media",
    };
    const mediaTicket = await metadata(query);
    const response = await request({ ...query, mediaTicket }, { ticketOnly: true });
    expect([response.status, await response.text()]).toEqual([200, "Saved assistant report"]);
    expect((await request({ ...query, messageId: "user-directive", meta: "1" })).status).toBe(404);
  });

  it("withholds mapped image bytes from unrelated readers and after workspace reassignment", async () => {
    const query = {
      source: "/workspace/.artifacts/proof/screenshot.png",
      messageId: "sandbox-screenshot",
    };
    const mediaTicket = await metadata(query);
    for (const selection of [query, { ...query, meta: "1" }]) {
      const unrelated = await request(selection, { unrelated: true });
      expect(unrelated.status).toBe(404);
      expect(Buffer.from(await unrelated.arrayBuffer())).not.toEqual(REAL_PNG);
    }
    const worktree = {
      id: owner.worktree.id,
      branch: owner.worktree.branch,
      repoRoot: owner.worktree.repoRoot,
    };
    await upsertSessionEntryCore(scope, { worktree: { ...worktree, id: randomUUID() } });
    try {
      const denied = await request({ ...query, mediaTicket }, { ticketOnly: true });
      expect(denied.status).toBe(404);
      expect(Buffer.from(await denied.arrayBuffer())).not.toEqual(REAL_PNG);
    } finally {
      await upsertSessionEntryCore(scope, { worktree });
    }
  });

  it.each(["queued", "stopped", "forwarded", "saved"] as const)(
    "rechecks the %s attachment association after preparing bytes",
    async (kind) => {
      const runId = `attachment-pending-${kind}`;
      const receipt =
        kind === "saved"
          ? undefined
          : await stageSessionPendingInput(scope, {
              runId,
              assertCurrent: () => {},
              message: {
                role: "user",
                content: "Saved pending comment",
                timestamp: 1,
                idempotencyKey: `${runId}:user`,
                ...(kind === "forwarded" ? { provenance: cronProvenance } : {}),
                __openclaw: { media: [{ url: source, contentType: "text/plain" }] },
              },
            });
      if (kind !== "saved") {
        expect(receipt).toBeDefined();
      }
      try {
        if (kind === "stopped") {
          receipt!.finish("cancelled");
          await receipt!.settled?.();
        }
        const query: Record<string, string> = receipt
          ? { messageId: `pending:${receipt.inputId}` }
          : {};
        const mediaTicket = await metadata(query);
        const ticketed = { ...query, mediaTicket };
        if (receipt) {
          const preview = await request(ticketed, { ticketOnly: true });
          expect([preview.status, await preview.text()]).toEqual([200, text]);
        }
        const file = state.statePath("media", "inbound", "selection-comment.txt");
        const open = fs.open;
        let changed = false;
        using _ = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
          const handle = await open(filePath, flags, mode);
          if (filePath === file && !changed) {
            if (receipt) {
              changed = await discardSessionPendingInput(scope, runId, () => {});
            } else {
              changed = true;
              await seed(ordinary);
            }
          }
          return handle;
        });
        const response = await request(ticketed, { ticketOnly: true });
        expect(changed).toBe(true);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(text);
        const followup = receipt
          ? await request({ ...query, meta: "1" })
          : await request(ticketed, { ticketOnly: true });
        expect(followup.status).toBe(404);
      } finally {
        receipt?.finish("cancelled");
        await receipt?.settled?.();
        if (!receipt) {
          await seed();
        }
      }
    },
  );

  const ticketSources: Record<string, string>[] = [
    {},
    { source: "/workspace/.artifacts/proof/screenshot.png", messageId: "sandbox-screenshot" },
  ];
  it.each(ticketSources)(
    "rechecks session and role access for issued tickets and metadata refresh (%j)",
    async (query) => {
      const mediaTicket = await metadata(query, { viewer: true });
      await upsertSessionEntryCore(scope, { visibility: "draft" });
      try {
        expect((await request({ ...query, mediaTicket }, { ticketOnly: true })).status).toBe(404);
        expect((await request({ ...query, mediaTicket, meta: "1" }, { viewer: true })).status).toBe(
          404,
        );
      } finally {
        await upsertSessionEntryCore(scope, { visibility: "shared" });
      }
      const ownTicket = await metadata(query);
      const before = config;
      config = structuredClone(config);
      config.gateway!.roles!.definitions.guest = readerRole("none", []);
      setRuntimeConfigSnapshot(config, config);
      try {
        expect(
          (await request({ ...query, mediaTicket: ownTicket }, { ticketOnly: true })).status,
        ).toBe(404);
        expect((await request({ ...query, mediaTicket: ownTicket, meta: "1" })).status).toBe(403);
      } finally {
        config = before;
        setRuntimeConfigSnapshot(config, config);
      }
    },
  );
});
