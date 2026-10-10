import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { mergeProfiles, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import { resolveHttpProfile } from "./http-auth-user-profile.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { invalidateSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const state = vi.hoisted(() => ({
  loaded: vi.fn(),
  auth: vi.fn(),
  placements: vi.fn(),
}));
vi.mock("./session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: state.loaded }));
vi.mock("./http-utils.js", () => ({ authorizeControlUiReadRequestOrReply: state.auth }));
vi.mock("./session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: { getMany: state.placements },
  }),
}));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
let temp: string;
let project: string;
let cfg: OpenClawConfig;
let entry: {
  sessionId: string;
  spawnedCwd?: string;
  sessionRoot?: string;
  permissionMode?: "full" | "workspace";
  execNode?: string;
  repositoryWorkspaceId?: string;
  incognito?: boolean;
  visibility?: "draft" | "shared";
};
const sessionKey = "agent:main:dashboard:media";

beforeEach(async () => {
  state.placements.mockReset().mockReturnValue(new Map());
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assistant-image-policy-")));
  project = path.join(temp, "project");
  await fs.mkdir(project);
  cfg = {
    agents: { entries: { main: { workspace: path.join(temp, "agent") } } },
    tools: { fs: { workspaceOnly: true } },
  };
  entry = {
    sessionId: "session-one",
    spawnedCwd: project,
    sessionRoot: project,
    permissionMode: "workspace",
  };
  state.loaded.mockImplementation((requestedKey: string) => ({
    cfg,
    agentId: "main",
    canonicalKey: requestedKey,
    entry,
  }));
  state.auth.mockResolvedValue({
    authMethod: "token",
    operatorScopes: ["operator.admin", "operator.read"],
  });
});
afterEach(async () => {
  await closeStateDatabaseForTest();
  await fs.rm(temp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function request(
  source: string,
  options: {
    ticket?: string;
    allow?: boolean;
    bytes?: boolean;
    sessionKey?: string;
    agentId?: string;
    unscoped?: boolean;
    method?: "GET" | "POST";
    omitAgent?: boolean;
  } = {},
) {
  const query = new URLSearchParams({ source });
  if (!options.unscoped) {
    query.set("sessionKey", options.sessionKey ?? sessionKey);
  }
  if (!options.omitAgent) {
    query.set("agentId", options.agentId ?? "main");
  }
  if (!options.bytes) {
    query.set("meta", "1");
  }
  if (options.ticket) {
    query.set("mediaTicket", options.ticket);
  }
  if (options.allow) {
    query.set("allow", "1");
  }
  const response = makeMockHttpResponse();
  const chunks: Buffer[] = [];
  response.res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = finished(response.res);
  await handleControlUiAssistantMediaRequest(
    {
      url: `/__openclaw__/assistant-media?${query}`,
      method: options.method ?? (options.allow ? "POST" : "GET"),
      headers: {},
      headersDistinct: {},
    } as IncomingMessage,
    response.res,
    { config: cfg, agentId: "main" },
  );
  await completed;
  const bytes = Buffer.concat(chunks);
  const body = bytes.toString("utf8");
  return {
    ...response,
    body,
    bytes,
    payload: body.startsWith("{") ? (JSON.parse(body) as Record<string, unknown>) : null,
  };
}

// The real HTTP boundary plus real files protect session-root admission and exact-file grants;
// existing media tests cover static agent roots only.
describe("assistant image session policy", () => {
  it("binds relative media tickets to the execution directory within the session root", async () => {
    const first = path.join(project, "first");
    const second = path.join(project, "second");
    for (const directory of [first, second]) {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "image.png"), PNG);
    }
    entry.spawnedCwd = first;
    const metadata = (await request("image.png")).payload;
    expect(metadata).toMatchObject({ available: true });
    const ticket = String(metadata!.mediaTicket);
    entry.spawnedCwd = second;
    expect((await request("image.png", { ticket, bytes: true })).res.statusCode).toBe(404);
    expect((await request("image.png")).payload).toMatchObject({ available: true });
    expect((await request("image.png", { unscoped: true })).res.statusCode).toBe(404);
  });

  it.each(["metadata", "bytes"] as const)(
    "rechecks the execution directory after asynchronous relative %s preparation",
    async (operation) => {
      const source = path.join(project, "image.png");
      await fs.writeFile(source, PNG);
      const openFile = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const file = await openFile(filePath, flags, mode);
        if (filePath === source) {
          entry.spawnedCwd = path.join(project, "another-directory");
        }
        return file;
      });
      const denied = await request("image.png", { bytes: operation === "bytes" });
      expect(denied.res.statusCode).toBe(404);
      expect(denied.bytes).not.toEqual(PNG);
    },
  );

  it("uses configured protection when there is no explicit session mode", async () => {
    delete entry.permissionMode;
    cfg.tools = { fs: { workspaceOnly: false } };
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    expect((await request(source)).payload).toMatchObject({ available: true });
    cfg.tools.fs!.workspaceOnly = true;
    expect((await request(source)).payload).toMatchObject({ available: false, canAllow: true });
  });

  it("offers an explicit exact-image grant and renews it without granting siblings", async () => {
    const source = path.join(temp, "outside.png");
    const sibling = path.join(temp, "sibling.png");
    await fs.writeFile(source, PNG);
    await fs.writeFile(sibling, PNG);
    expect((await request(source)).payload).toMatchObject({
      available: false,
      code: "outside-allowed-folders",
      canAllow: true,
      retryable: false,
    });
    const allowed = (await request(source, { allow: true })).payload!;
    expect(allowed).toMatchObject({ available: true, mediaTicket: expect.any(String) });
    const ticket = String(allowed.mediaTicket);
    expect((await request(source, { ticket })).payload).toMatchObject({ available: true });
    expect((await request(sibling, { ticket })).payload).toMatchObject({ available: false });
    const bytes = await request(source, { ticket, bytes: true });
    expect(bytes.res.statusCode).toBe(200);
    expect(bytes.bytes).toEqual(PNG);
    expect(bytes.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
  });

  it("does not let a reader grant outside access or renew an administrator's allowance", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    const allowed = (await request(source, { allow: true })).payload!;
    state.auth.mockResolvedValue({ authMethod: "device-token", operatorScopes: ["operator.read"] });
    expect((await request(source)).payload).not.toHaveProperty("canAllow", true);
    expect((await request(source, { allow: true })).res.statusCode).toBe(403);
    expect((await request(source, { ticket: String(allowed.mediaTicket) })).payload).toMatchObject({
      available: false,
    });
  });

  it("rejects a replaced file and a replaced session when replaying an exact-image ticket", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    const ticket = String((await request(source, { allow: true })).payload!.mediaTicket);
    await fs.rename(source, `${source}.old`);
    await fs.writeFile(source, PNG);
    expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
    expect((await request(source, { ticket })).payload).toMatchObject({
      available: false,
      canAllow: true,
    });
    await fs.rm(source);
    await fs.rename(`${source}.old`, source);
    entry.sessionId = "replacement";
    expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
  });

  it("does not grant an outside text file or a symlink escape under a protected project", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, "not an image");
    expect((await request(source, { allow: true })).payload).toMatchObject({ available: false });
    await fs.writeFile(source, PNG);
    const link = path.join(project, "link.png");
    await fs.symlink(source, link);
    expect((await request(link)).payload).toMatchObject({ available: false, canAllow: true });
  });

  it.each(["execNode"] as const)(
    "does not interpret %s session paths as Gateway-local image paths",
    async (owner) => {
      entry[owner] = "remote-workspace";
      const source = path.join(project, "image.png");
      await fs.writeFile(source, PNG);
      expect((await request(source)).payload).toMatchObject({
        available: false,
        code: "blocked-local-file",
      });
    },
  );
  it("keeps repository Full Access and Allow from exposing the configured Gateway workspace", async () => {
    entry.permissionMode = "full";
    const source = path.join(temp, "agent", "unrelated.png");
    await fs.mkdir(path.dirname(source));
    await fs.writeFile(source, PNG);
    const ticket = String((await request(source)).payload!.mediaTicket);
    entry.repositoryWorkspaceId = "repository-workspace";
    delete entry.spawnedCwd;
    delete entry.sessionRoot;
    for (const options of [{}, { allow: true }]) {
      const denied = (await request(source, options)).payload;
      expect(denied).toMatchObject({ available: false, code: "blocked-local-file" });
      expect(denied).not.toHaveProperty("canAllow", true);
    }
    expect((await request(source, { bytes: true, ticket })).res.statusCode).toBe(404);
  });
  it("keeps protected project images separate from the unrelated configured agent workspace", async () => {
    const source = path.join(temp, "agent", "unrelated.png");
    await fs.mkdir(path.dirname(source));
    await fs.writeFile(source, PNG);
    expect((await request(source)).payload).toMatchObject({ available: false, canAllow: true });
  });

  it("rechecks full-to-workspace changes for existing byte tickets and metadata renewal", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    entry.permissionMode = "full";
    const ticket = String((await request(source)).payload!.mediaTicket);
    entry.permissionMode = "workspace";
    expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
    expect((await request(source, { ticket })).payload).toMatchObject({
      available: false,
      canAllow: true,
    });
  });

  it.each(["workspace"] as const)("recognizes real outside SVG images in %s mode", async (mode) => {
    entry.permissionMode = mode;
    const source = path.join(temp, "diagram.svg");
    await fs.writeFile(
      source,
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    const result = await request(source, { allow: mode === "workspace" });
    expect(result.payload).toMatchObject({ available: true, mimeType: "image/svg+xml" });
    const bytes = await request(source, {
      ticket: String(result.payload!.mediaTicket),
      bytes: true,
    });
    expect(bytes.res.statusCode).toBe(200);
    expect(bytes.bytes).toEqual(await fs.readFile(source));
    expect(bytes.setHeader).toHaveBeenCalledWith(
      "content-security-policy",
      expect.stringContaining("sandbox"),
    );
  });

  it("denies incognito images to a named profile while preserving administrator access", async () => {
    const source = path.join(project, "private.png");
    await fs.writeFile(source, PNG);
    entry.incognito = true;
    state.auth.mockResolvedValue({
      authMethod: "trusted-proxy",
      operatorScopes: ["operator.read"],
      authenticatedUserProfile: {
        profileId: "reader",
        displayName: null,
        hasAvatar: false,
        updatedAt: 0,
      },
    });
    expect((await request(source)).res.statusCode).toBe(404);
    state.auth.mockResolvedValue({ authMethod: "token", operatorScopes: ["operator.admin"] });
    expect((await request(source)).payload).toMatchObject({ available: true });
  });

  it("keeps unscoped readers on the default static roots even when a query selects a full-access agent", async () => {
    cfg.tools = { fs: { workspaceOnly: false } };
    cfg.agents!.entries!.other = { workspace: project };
    const source = path.join(project, "private.png");
    await fs.writeFile(source, PNG);
    state.auth.mockResolvedValue({ authMethod: "device-token", operatorScopes: ["operator.read"] });
    expect((await request(source, { unscoped: true, agentId: "other" })).payload).toMatchObject({
      available: false,
    });
    expect((await request(source, { unscoped: true, allow: true })).res.statusCode).toBe(403);
  });

  it("selects the scoped session's agent when its optional agent parameter is omitted", async () => {
    cfg.agents!.entries!.other = { workspace: project };
    state.loaded.mockImplementation((requestedKey: string) => ({
      cfg,
      agentId: "other",
      canonicalKey: requestedKey,
      entry,
    }));
    const source = path.join(project, "image.png");
    await fs.writeFile(source, PNG);
    expect(
      (await request(source, { sessionKey: "agent:other:dashboard:media", omitAgent: true }))
        .payload,
    ).toMatchObject({ available: true });
  });

  it("does not accept GET consent or move an allowed image ticket to another session", async () => {
    const source = path.join(temp, "outside.png");
    await fs.writeFile(source, PNG);
    expect((await request(source, { allow: true, method: "GET" })).payload).toMatchObject({
      available: false,
    });
    const ticket = String((await request(source, { allow: true })).payload!.mediaTicket);
    expect(
      (await request(source, { ticket, bytes: true, sessionKey: `${sessionKey}-other` })).res
        .statusCode,
    ).toBe(404);
    expect((await request(source, { ticket, bytes: true, unscoped: true })).res.statusCode).toBe(
      404,
    );
  });

  it.each(["repositoryWorkspaceId"] as const)(
    "keeps Gateway-owned inbound images available in a %s session",
    async (owner) => {
      entry[owner] = "remote-workspace";
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "state") }, async () => {
        const id = "remote-session-upload.png";
        const source = `media://inbound/${id}`;
        const file = path.join(resolveStateDir(), "media", "inbound", id);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, PNG);
        const metadata = await request(source);
        expect(metadata.payload).toMatchObject({ available: true });
        const served = await request(source, {
          ticket: String(metadata.payload!.mediaTicket),
          bytes: true,
        });
        expect(served.res.statusCode).toBe(200);
        expect(served.bytes).toEqual(PNG);
      });
    },
  );
  it("keeps merged-profile media tickets bound to the canonical person's current plugin access", async () => {
    const pluginId = "media-reader-access";
    const grant = new AbortController();
    const authorize = vi.fn<PluginGatewayAccessPolicy["authorize"]>(() => ({
      signal: grant.signal,
      assertCurrent: () => grant.signal.throwIfAborted(),
    }));
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: pluginId }));
    registry.gatewayAccessPolicies.push({ pluginId, source: "fixture", policy: { authorize } });
    const previous = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(registry, null, "default");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "profile-state") }, async () => {
        cfg.gateway = {
          roles: {
            default: "viewer",
            definitions: {
              viewer: {
                sessions: { others: "view" },
                agents: "*",
                scopes: ["operator.read"],
                accessPolicyPlugin: pluginId,
              },
            },
          },
        };
        const profile = ensureProfileForEmail("media-alias@example.test");
        const canonical = ensureProfileForEmail("media-canonical@example.test");
        const catalog = await prepareUserProfileCatalog();
        onTestFinished(catalog.release);
        state.auth.mockResolvedValue({
          authMethod: "trusted-proxy",
          operatorScopes: ["operator.read"],
          ...resolveHttpProfile(profile.id, cfg),
        });
        const source = path.join(project, "shared.png");
        await fs.writeFile(source, PNG);
        const metadata = await request(source);
        expect(metadata.payload).toMatchObject({ available: true });
        const ticket = String(metadata.payload!.mediaTicket);
        mergeProfiles(profile.id, canonical.id);
        expect((await request(source, { ticket, bytes: true })).bytes).toEqual(PNG);
        expect(authorize.mock.calls.at(-1)?.[0].profile.profileId).toBe(canonical.id);
        grant.abort();
        expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
      });
    } finally {
      rollbackStagedPluginRegistry(previous);
    }
  });

  it.each(["role assignment", "role definition"] as const)(
    "revalidates a named reader's saved media ticket after %s withdrawal",
    async (change) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "profile-state") }, async () => {
        cfg.gateway = {
          roles: {
            default: "viewer",
            definitions: {
              viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
              denied: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        };
        const profile = ensureProfileForEmail("media-reader@example.test");
        const catalog = await prepareUserProfileCatalog();
        onTestFinished(catalog.release);
        state.auth.mockResolvedValue({
          authMethod: "trusted-proxy",
          operatorScopes: ["operator.read"],
          ...resolveHttpProfile(profile.id, cfg),
        });
        const source = path.join(project, "shared.png");
        await fs.writeFile(source, PNG);
        const metadata = await request(source);
        expect(metadata.payload).toMatchObject({ available: true });
        const ticket = String(metadata.payload!.mediaTicket);
        // Ordinary mutations elsewhere must not revoke a still-authorized reader's ticket.
        invalidateSessionSharingSnapshot("agent:main:unrelated");
        expect((await request(source, { ticket, bytes: true })).bytes).toEqual(PNG);
        if (change === "role assignment") {
          setUserProfileRole(profile.id, "denied");
          invalidateOperatorRolePolicy(profile.id);
        } else {
          cfg.gateway!.roles!.definitions.viewer = {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read"],
          };
        }
        await fs.rename(source, `${source}.old`);
        await fs.writeFile(source, PNG);
        const denied = await request(source, { ticket, bytes: true });
        expect(denied.res.statusCode).toBe(404);
        expect(denied.bytes).not.toEqual(PNG);
      });
    },
  );

  it.each(
    (["metadata", "bytes"] as const).flatMap((operation) =>
      (["session", "gateway"] as const).map((authority) => ({ operation, authority })),
    ),
  )(
    "revalidates $authority reader access after asynchronous $operation file preparation",
    async ({ operation, authority }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "profile-state") }, async () => {
        cfg.gateway = {
          roles: {
            default: "viewer",
            definitions: {
              viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        };
        const profile = ensureProfileForEmail("yielding-media-reader@example.test");
        const catalog = await prepareUserProfileCatalog();
        onTestFinished(catalog.release);
        let current = true;
        state.auth.mockResolvedValue({
          authMethod: "trusted-proxy",
          operatorScopes: ["operator.read"],
          hasCurrentClientAuthority: () => current,
          ...resolveHttpProfile(profile.id, cfg),
        });
        const source = path.join(project, "shared.png");
        await fs.writeFile(source, PNG);
        const ticket = String((await request(source)).payload!.mediaTicket);
        const openFile = fs.open;
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
          const file = await openFile(filePath, flags, mode);
          if (filePath === source) {
            if (authority === "session") {
              entry.visibility = "draft";
              invalidateSessionSharingSnapshot(sessionKey);
            } else {
              current = false;
            }
          }
          return file;
        });
        try {
          const denied = await request(source, {
            ...(authority === "session" ? { ticket } : {}),
            bytes: operation === "bytes",
          });
          expect(denied.res.statusCode).toBe(404);
          expect(denied.bytes).not.toEqual(PNG);
        } finally {
          openSpy.mockRestore();
        }
      });
    },
  );

  it.each(["metadata", "bytes"] as const)(
    "withdraws Gateway-local media after cloud dispatch during %s preparation",
    async (operation) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(temp, "placement-state") }, async () => {
        const { createWorkerSessionPlacementStore } =
          await import("./worker-environments/placement-store.js");
        const placements = createWorkerSessionPlacementStore();
        state.placements.mockImplementation((sessionIds: readonly string[]) =>
          placements.getMany(sessionIds),
        );
        entry.permissionMode = "full";
        const source = path.join(temp, "gateway-only.png");
        await fs.writeFile(source, PNG);
        const ticket = String((await request(source)).payload!.mediaTicket);
        const openFile = fs.open;
        let dispatched = false;
        let preparedFile: Awaited<ReturnType<typeof fs.open>> | undefined;
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
          const file = await openFile(filePath, flags, mode);
          if (filePath === source && !dispatched) {
            preparedFile = file;
            dispatched = true;
            // Dispatch admission already withdraws Gateway-local access; activation needs an
            // attached environment and must not turn this file-open hook into a false 404.
            await placements.startDispatch({
              sessionId: entry.sessionId,
              sessionKey,
              agentId: "main",
              executionMode: "worker-turn",
            });
          }
          return file;
        });
        try {
          const denied = await request(source, { ticket, bytes: operation === "bytes" });
          expect(dispatched).toBe(true);
          expect(placements.get(entry.sessionId)?.state).toBe("requested");
          expect(preparedFile?.fd).toBe(-1);
          expect(entry.execNode).toBeUndefined();
          expect(denied.res.statusCode).toBe(404);
          expect(denied.bytes).not.toEqual(PNG);
        } finally {
          openSpy.mockRestore();
          await preparedFile?.close();
        }
      });
    },
  );

  it.each([
    { name: "report.pdf", content: "%PDF-1.7\nexisting report\n", mime: "application/pdf" },
  ])(
    "preserves legacy Full Access $name attachments under the configured agent workspace",
    async ({ name, content, mime }) => {
      entry.permissionMode = "full";
      const source = path.join(temp, "agent", name);
      await fs.mkdir(path.dirname(source));
      await fs.writeFile(source, content);
      const served = await request(source, { bytes: true });
      expect(served.res.statusCode).toBe(200);
      expect(served.bytes).toEqual(Buffer.from(content));
      expect(served.setHeader).toHaveBeenCalledWith("Content-Type", mime);
      const outside = path.join(temp, name);
      await fs.writeFile(outside, content);
      expect((await request(outside, { bytes: true })).res.statusCode).toBe(404);
    },
  );
});
