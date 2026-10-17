import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { mergeProfiles, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import { resolveHttpProfile } from "./http-auth-user-profile.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const state = vi.hoisted(() => ({
  loaded: vi.fn(),
  retained: vi.fn(),
  config: undefined as OpenClawConfig | undefined,
  auth: vi.fn(),
  placements: vi.fn(),
  placementsAsync: vi.fn(),
}));
vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string }) =>
    state.loaded(params.key),
}));
vi.mock("../config/sessions/session-entry-read-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-facts.js")>()),
  readRetainedSessionEntryFacts: (_database: unknown, selection: unknown) =>
    state.retained(selection),
}));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => state.config ?? {},
}));
vi.mock("./http-utils.js", () => ({ authorizeControlUiReadRequestOrReply: state.auth }));
vi.mock("./session-worker-placement-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-worker-placement-context.js")>()),
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: state.placements,
      getManyAsync: state.placementsAsync,
    },
  }),
}));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
let temp: string;
let project: string;
let cfg: OpenClawConfig;
let entry: InternalSessionEntry;
let restoreEnv = () => {};
const sessionKey = "agent:main:dashboard:media";
const readScopes = ["operator.read"];
const viewerRole = { sessions: { others: "view" }, agents: "*", scopes: readScopes } as const;

async function image(name = "image.png", root = project, contents: string | Buffer = PNG) {
  const source = path.join(root, name);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, contents);
  return source;
}

async function namedReader(
  email: string,
  definitions: GatewayOperatorRolesConfig["definitions"] = { viewer: viewerRole },
  hasCurrentClientAuthority?: () => boolean,
) {
  cfg.gateway = { roles: { default: "viewer", definitions } };
  const profile = ensureProfileForEmail(email);
  const catalog = await prepareUserProfileCatalog();
  onTestFinished(catalog.release);
  state.auth.mockResolvedValue({
    authMethod: "trusted-proxy",
    operatorScopes: readScopes,
    ...(hasCurrentClientAuthority ? { hasCurrentClientAuthority } : {}),
    ...resolveHttpProfile(profile.id, cfg),
  });
  return profile;
}

async function placementStore() {
  const { createWorkerSessionPlacementStore } =
    await import("./worker-environments/placement-store.js");
  const placements = createWorkerSessionPlacementStore();
  state.placements.mockImplementation((ids: readonly string[]) => placements.getMany(ids));
  state.placementsAsync.mockImplementation((ids: readonly string[]) =>
    placements.getManyAsync(ids),
  );
  return placements;
}

function onOpen(
  source: string,
  run: (file: Awaited<ReturnType<typeof fs.open>>) => void | Promise<void>,
) {
  const open = fs.open;
  return vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
    const file = await open(filePath, flags, mode);
    if (filePath === source) {
      await run(file);
    }
    return file;
  });
}

beforeEach(async () => {
  restoreEnv = captureEnv(["OPENCLAW_STATE_DIR"]).restore;
  state.placements.mockReset().mockReturnValue(new Map());
  state.placementsAsync
    .mockReset()
    .mockImplementation(async (sessionIds: readonly string[]) => state.placements(sessionIds));
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assistant-image-policy-")));
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(temp, "state"));
  project = path.join(temp, "project");
  await fs.mkdir(project);
  cfg = {
    agents: { entries: { main: { workspace: path.join(temp, "agent") } } },
    tools: { fs: { workspaceOnly: true } },
  };
  state.config = cfg;
  entry = {
    sessionId: "session-one",
    updatedAt: 1,
    spawnedCwd: project,
    sessionRoot: project,
    permissionMode: "workspace",
  };
  state.loaded.mockImplementation((requestedKey: string) => ({
    cfg,
    agentId: "main",
    canonicalKey: requestedKey,
    storePath: path.join(temp, "sessions.json"),
    entry,
  }));
  state.retained.mockImplementation(({ sessionKeys }: { sessionKeys: string[] }) => ({
    entries: sessionKeys.map((key) => ({ sessionKey: key, entry })),
  }));
  state.auth.mockResolvedValue({
    authMethod: "token",
    operatorScopes: ["operator.admin", "operator.read"],
  });
});
afterEach(async () => {
  try {
    await closeStateDatabaseForTest();
    await fs.rm(temp, { recursive: true, force: true });
  } finally {
    vi.restoreAllMocks();
    restoreEnv();
  }
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
    bytes,
    payload: body.startsWith("{") ? (JSON.parse(body) as Record<string, unknown>) : null,
  };
}

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
    const source = await image();
    onOpen(source, () => {
      entry.spawnedCwd = path.join(project, "another-directory");
    });
    const denied = await request("image.png", { bytes: operation === "bytes" });
    expect(denied.res.statusCode).toBe(404);
    expect(denied.bytes).not.toEqual(PNG);
  },
);

it("uses configured protection when there is no explicit session mode", async () => {
  delete entry.permissionMode;
  cfg.tools = { fs: { workspaceOnly: false } };
  const source = await image("outside.png", temp);
  expect((await request(source)).payload).toMatchObject({ available: true });
  cfg.tools.fs!.workspaceOnly = true;
  expect((await request(source)).payload).toMatchObject({ available: false, canAllow: true });
});

it("offers an explicit exact-image grant and renews it without granting siblings", async () => {
  const source = await image("outside.png", temp);
  const sibling = await image("sibling.png", temp);
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
  const source = await image("outside.png", temp);
  const allowed = (await request(source, { allow: true })).payload!;
  state.auth.mockResolvedValue({ authMethod: "device-token", operatorScopes: ["operator.read"] });
  expect((await request(source)).payload).not.toHaveProperty("canAllow", true);
  expect((await request(source, { allow: true })).res.statusCode).toBe(403);
  expect((await request(source, { ticket: String(allowed.mediaTicket) })).payload).toMatchObject({
    available: false,
  });
});

it("rejects a replaced file and a replaced session when replaying an exact-image ticket", async () => {
  const source = await image("outside.png", temp);
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
  const source = await image("outside.png", temp, "not an image");
  expect((await request(source, { allow: true })).payload).toMatchObject({ available: false });
  await fs.writeFile(source, PNG);
  const link = path.join(project, "link.png");
  await fs.symlink(source, link);
  expect((await request(link)).payload).toMatchObject({ available: false, canAllow: true });
});

it("does not interpret execNode session paths as Gateway-local image paths", async () => {
  entry.execNode = "remote-workspace";
  const source = await image();
  expect((await request(source)).payload).toMatchObject({
    available: false,
    code: "blocked-local-file",
  });
});
it("keeps device-folder Full Access off Gateway-local image paths", async () => {
  entry.permissionMode = "full";
  entry.deviceFolder = { deviceId: "paired-device", path: project };
  const source = await image();
  for (const options of [{}, { allow: true }]) {
    expect((await request(source, options)).payload).toMatchObject({
      available: false,
      code: "blocked-local-file",
    });
  }
});

it("keeps repository Full Access and Allow from exposing the configured Gateway workspace", async () => {
  entry.permissionMode = "full";
  const source = await image("unrelated.png", path.join(temp, "agent"));
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
  const source = await image("unrelated.png", path.join(temp, "agent"));
  expect((await request(source)).payload).toMatchObject({ available: false, canAllow: true });
});

it("rechecks full-to-workspace changes for existing byte tickets and metadata renewal", async () => {
  const source = await image("outside.png", temp);
  entry.permissionMode = "full";
  const ticket = String((await request(source)).payload!.mediaTicket);
  entry.permissionMode = "workspace";
  expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
  expect((await request(source, { ticket })).payload).toMatchObject({
    available: false,
    canAllow: true,
  });
});

it("recognizes real outside SVG images in workspace mode", async () => {
  const source = await image(
    "diagram.svg",
    temp,
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const result = await request(source, { allow: true });
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
  const source = await image("private.png");
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
  const source = await image("private.png");
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
    storePath: path.join(temp, "other-sessions.json"),
    entry,
  }));
  const source = await image();
  expect(
    (await request(source, { sessionKey: "agent:other:dashboard:media", omitAgent: true })).payload,
  ).toMatchObject({ available: true });
});

it("does not accept GET consent or move an allowed image ticket to another session", async () => {
  const source = await image("outside.png", temp);
  expect((await request(source, { allow: true, method: "GET" })).payload).toMatchObject({
    available: false,
  });
  const ticket = String((await request(source, { allow: true })).payload!.mediaTicket);
  expect(
    (await request(source, { ticket, bytes: true, sessionKey: `${sessionKey}-other` })).res
      .statusCode,
  ).toBe(404);
  expect((await request(source, { ticket, bytes: true, unscoped: true })).res.statusCode).toBe(404);
});

it("keeps Gateway-owned inbound images available in a repository session", async () => {
  entry.repositoryWorkspaceId = "remote-workspace";
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
    const canonical = ensureProfileForEmail("media-canonical@example.test");
    const profile = await namedReader("media-alias@example.test", {
      viewer: { ...viewerRole, accessPolicyPlugin: pluginId },
    });
    const source = await image("shared.png");
    const metadata = await request(source);
    expect(metadata.payload).toMatchObject({ available: true });
    const ticket = String(metadata.payload!.mediaTicket);
    mergeProfiles(profile.id, canonical.id);
    expect((await request(source, { ticket, bytes: true })).bytes).toEqual(PNG);
    expect(authorize.mock.calls.at(-1)?.[0].profile.profileId).toBe(canonical.id);
    grant.abort();
    expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
  } finally {
    rollbackStagedPluginRegistry(previous);
  }
});

it.each(["role assignment", "role definition"] as const)(
  "revalidates a named reader's saved media ticket after %s withdrawal",
  async (change) => {
    const profile = await namedReader("media-reader@example.test", {
      viewer: viewerRole,
      denied: { ...viewerRole, sessions: { others: "none" } },
    });
    const source = await image("shared.png");
    const metadata = await request(source);
    expect(metadata.payload).toMatchObject({ available: true });
    const ticket = String(metadata.payload!.mediaTicket);
    if (change === "role assignment") {
      setUserProfileRole(profile.id, "denied");
      invalidateOperatorRolePolicy(profile.id);
    } else {
      cfg.gateway!.roles!.definitions.viewer = { ...viewerRole, sessions: { others: "none" } };
    }
    await fs.rename(source, `${source}.old`);
    await fs.writeFile(source, PNG);
    const denied = await request(source, { ticket, bytes: true });
    expect(denied.res.statusCode).toBe(404);
    expect(denied.bytes).not.toEqual(PNG);
  },
);

it.each(
  (["metadata", "bytes"] as const).flatMap((operation) =>
    (["session", "gateway"] as const).map((authority) => ({ operation, authority })),
  ),
)(
  "revalidates $authority reader access after asynchronous $operation file preparation",
  async ({ operation, authority }) => {
    let current = true;
    await namedReader("yielding-media-reader@example.test", undefined, () => current);
    const source = await image("shared.png");
    const ticket = String((await request(source)).payload!.mediaTicket);
    const openSpy = onOpen(source, () => {
      if (authority === "session") {
        entry.visibility = "draft";
      } else {
        current = false;
      }
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
  },
);

it.each([
  ["dispatch", "metadata"],
  ["dispatch", "bytes"],
  ["database replacement", "bytes"],
] as const)(
  "withdraws Gateway-local media after %s during %s preparation",
  async (change, operation) => {
    const placements = await placementStore();
    entry.permissionMode = "full";
    const source = await image("gateway-only.png", temp);
    const metadata = await request(source);
    expect(metadata.res.statusCode).toBe(200);
    expect(metadata.payload?.mediaTicket).toEqual(expect.any(String));
    const ticket = String(metadata.payload!.mediaTicket);
    const databasePath = resolveOpenClawStateSqlitePath();
    const originalInode =
      change === "database replacement" ? (await fs.stat(databasePath)).ino : undefined;
    let changed = false;
    let changeError: unknown;
    let preparedFile: Awaited<ReturnType<typeof fs.open>> | undefined;
    const openSpy = onOpen(source, async (file) => {
      if (preparedFile) {
        return;
      }
      preparedFile = file;
      try {
        if (change === "dispatch") {
          // Admission alone withdraws local access; activation requires an attached environment.
          await placements.startDispatch({
            sessionId: entry.sessionId,
            sessionKey,
            agentId: "main",
            executionMode: "worker-turn",
          });
        } else {
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
          await fs.rename(databasePath, `${databasePath}.retired`);
          const { createWorkerSessionPlacementStore } =
            await import("./worker-environments/placement-store.js");
          expect(await createWorkerSessionPlacementStore().getManyAsync([entry.sessionId])).toEqual(
            new Map(),
          );
          expect((await fs.stat(databasePath)).ino).not.toBe(originalInode);
        }
        changed = true;
      } catch (error) {
        // Fixture failures must not become the handler's expected 404.
        changeError = error;
      }
    });
    try {
      const denied = await request(source, { ticket, bytes: operation === "bytes" });
      expect(changeError).toBeUndefined();
      expect(changed).toBe(true);
      if (change === "dispatch") {
        expect(placements.get(entry.sessionId)?.state).toBe("requested");
      }
      expect(preparedFile?.fd).toBe(-1);
      expect(entry.execNode).toBeUndefined();
      expect(denied.res.statusCode).toBe(404);
      expect(denied.bytes).not.toEqual(PNG);
    } finally {
      openSpy.mockRestore();
      await preparedFile?.close();
    }
  },
);

it("preserves legacy Full Access PDF attachments under the configured agent workspace", async () => {
  const name = "report.pdf";
  const content = "%PDF-1.7\nexisting report\n";
  entry.permissionMode = "full";
  const source = await image(name, path.join(temp, "agent"), content);
  const served = await request(source, { bytes: true });
  expect(served.res.statusCode).toBe(200);
  expect(served.bytes).toEqual(Buffer.from(content));
  expect(served.setHeader).toHaveBeenCalledWith("Content-Type", "application/pdf");
  const outside = path.join(temp, name);
  await fs.writeFile(outside, content);
  expect((await request(outside, { bytes: true })).res.statusCode).toBe(404);
});
