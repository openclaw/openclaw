import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mockStoppedWorkspaceContainer } from "../agents/sandbox/mount-plan.test-helpers.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
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
const readScopes: GatewayOperatorRolesConfig["definitions"][string]["scopes"] = ["operator.read"];
const viewerRole = { sessions: { others: "view" }, agents: "*", scopes: readScopes } as const;

async function image(name = "image.png", root = project, contents: string | Buffer = PNG) {
  const source = path.join(root, name);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, contents);
  return source;
}

async function managedWorkspace() {
  entry.sandbox = "required";
  entry.worktree = { id: randomUUID(), branch: "screenshots", repoRoot: temp };
  await insertRegistryWorktree(process.env, {
    ...entry.worktree,
    name: "screenshots",
    path: project,
    repoFingerprint: "test",
    baseRef: "main",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 0,
    lastActiveAt: 0,
  });
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
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  restoreEnv = () => env.restore();
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
  const query = new URLSearchParams({
    source,
    ...(!options.unscoped && { sessionKey: options.sessionKey ?? sessionKey }),
    ...(!options.omitAgent && { agentId: options.agentId ?? "main" }),
    ...(!options.bytes && { meta: "1" }),
    ...(options.ticket && { mediaTicket: options.ticket }),
    ...(options.allow && { allow: "1" }),
  });
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

type RequestOptions = NonNullable<Parameters<typeof request>[1]>;
async function expectMetadata(
  source: string,
  expected: Record<string, unknown>,
  options?: RequestOptions,
) {
  const response = await request(source, options);
  expect(response.payload).toMatchObject(expected);
  return response;
}
async function mediaTicket(source: string, options?: RequestOptions) {
  const { payload } = await expectMetadata(
    source,
    { available: true, mediaTicket: expect.any(String) },
    options,
  );
  return String(payload!.mediaTicket);
}
async function expectWithheld(source: string, options?: RequestOptions) {
  const denied = await request(source, options);
  expect(denied.res.statusCode).toBe(404);
  expect(denied.bytes).not.toEqual(PNG);
}
async function expectBytes(source: string, options: RequestOptions, bytes = PNG, mime?: string) {
  const served = await request(source, { ...options, bytes: true });
  expect(served.res.statusCode).toBe(200);
  expect(served.bytes).toEqual(bytes);
  if (mime) {
    expect(served.setHeader).toHaveBeenCalledWith("Content-Type", mime);
  }
  return served;
}

it("binds relative media tickets to the execution directory within the session root", async () => {
  const first = path.join(project, "first");
  const second = path.join(project, "second");
  await Promise.all([first, second].map((directory) => image("image.png", directory)));
  entry.spawnedCwd = first;
  const ticket = await mediaTicket("image.png");
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
    await expectWithheld("image.png", { bytes: operation === "bytes" });
  },
);

it("uses configured protection when there is no explicit session mode", async () => {
  delete entry.permissionMode;
  cfg.tools = { fs: { workspaceOnly: false } };
  const source = await image("outside.png", temp);
  await expectMetadata(source, { available: true });
  cfg.tools.fs!.workspaceOnly = true;
  await expectMetadata(source, { available: false, canAllow: true });
});

it.each([undefined, "required"] as const)(
  "offers and renews an exact-image administrator grant with sandbox %s without granting siblings",
  async (sandbox) => {
    entry.sandbox = sandbox;
    if (sandbox) {
      entry.permissionMode = "full";
    }
    const source = await image("outside.png", temp);
    const sibling = await image("sibling.png", temp);
    await expectMetadata(source, {
      available: false,
      code: "outside-allowed-folders",
      canAllow: true,
      retryable: false,
    });
    const ticket = await mediaTicket(source, { allow: true });
    await expectMetadata(source, { available: true }, { ticket });
    await expectMetadata(sibling, { available: false }, { ticket });
    await expectBytes(source, { ticket }, PNG, "image/png");
  },
);

it("does not let a reader grant outside access or renew an administrator's allowance", async () => {
  const source = await image("outside.png", temp);
  const ticket = await mediaTicket(source, { allow: true });
  state.auth.mockResolvedValue({ authMethod: "device-token", operatorScopes: ["operator.read"] });
  expect((await request(source)).payload).not.toHaveProperty("canAllow", true);
  expect((await request(source, { allow: true })).res.statusCode).toBe(403);
  await expectMetadata(source, { available: false }, { ticket });
});

it("rejects a replaced file and a replaced session when replaying an exact-image ticket", async () => {
  const source = await image("outside.png", temp);
  const ticket = await mediaTicket(source, { allow: true });
  await fs.rename(source, `${source}.old`);
  await fs.writeFile(source, PNG);
  expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
  await expectMetadata(source, { available: false, canAllow: true }, { ticket });
  await fs.rm(source);
  await fs.rename(`${source}.old`, source);
  entry.sessionId = "replacement";
  expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
});

it("does not grant an outside text file or a symlink escape under a protected project", async () => {
  const source = await image("outside.png", temp, "not an image");
  await expectMetadata(source, { available: false }, { allow: true });
  await fs.writeFile(source, PNG);
  const link = path.join(project, "link.png");
  await fs.symlink(source, link);
  await expectMetadata(link, { available: false, canAllow: true });
});

it("does not interpret execNode session paths as Gateway-local image paths", async () => {
  entry.execNode = "remote-workspace";
  const source = await image();
  await expectMetadata(source, { available: false, code: "blocked-local-file" });
});
it("keeps device-folder Full Access off Gateway-local image paths", async () => {
  entry.permissionMode = "full";
  entry.deviceFolder = { deviceId: "paired-device", path: project };
  const source = await image();
  for (const options of [{}, { allow: true }]) {
    await expectMetadata(source, { available: false, code: "blocked-local-file" }, options);
  }
});

it("keeps repository Full Access and Allow from exposing the configured Gateway workspace", async () => {
  entry.permissionMode = "full";
  const source = await image("unrelated.png", path.join(temp, "agent"));
  const ticket = await mediaTicket(source);
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
  await expectMetadata(source, { available: false, canAllow: true });
});

it("rechecks full-to-workspace changes for existing byte tickets and metadata renewal", async () => {
  const source = await image("outside.png", temp);
  entry.permissionMode = "full";
  const ticket = await mediaTicket(source);
  entry.permissionMode = "workspace";
  expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
  await expectMetadata(source, { available: false, canAllow: true }, { ticket });
});

it("recognizes real outside SVG images in workspace mode", async () => {
  const source = await image(
    "diagram.svg",
    temp,
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const result = await expectMetadata(
    source,
    { available: true, mimeType: "image/svg+xml" },
    { allow: true },
  );
  const bytes = await expectBytes(
    source,
    { ticket: String(result.payload!.mediaTicket) },
    await fs.readFile(source),
  );
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
    authenticatedUserProfile: { profileId: "reader" },
  });
  expect((await request(source)).res.statusCode).toBe(404);
  state.auth.mockResolvedValue({ authMethod: "token", operatorScopes: ["operator.admin"] });
  await expectMetadata(source, { available: true });
});

it("keeps unscoped readers on the default static roots even when a query selects a full-access agent", async () => {
  cfg.tools = { fs: { workspaceOnly: false } };
  cfg.agents!.entries!.other = { workspace: project };
  const source = await image("private.png");
  state.auth.mockResolvedValue({ authMethod: "device-token", operatorScopes: ["operator.read"] });
  await expectMetadata(source, { available: false }, { unscoped: true, agentId: "other" });
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
  await expectMetadata(
    source,
    { available: true },
    { sessionKey: "agent:other:dashboard:media", omitAgent: true },
  );
});

it("does not accept GET consent or move an allowed image ticket to another session", async () => {
  const source = await image("outside.png", temp);
  await expectMetadata(source, { available: false }, { allow: true, method: "GET" });
  const ticket = await mediaTicket(source, { allow: true });
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
  await expectBytes(source, { ticket: await mediaTicket(source) });
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
    const ticket = await mediaTicket(source);
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
    const ticket = await mediaTicket(source);
    if (change === "role assignment") {
      setUserProfileRole(profile.id, "denied");
      invalidateOperatorRolePolicy(profile.id);
    } else {
      cfg.gateway!.roles!.definitions.viewer = { ...viewerRole, sessions: { others: "none" } };
    }
    await fs.rename(source, `${source}.old`);
    await fs.writeFile(source, PNG);
    await expectWithheld(source, { ticket, bytes: true });
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
    const ticket = await mediaTicket(source);
    onOpen(source, () => {
      if (authority === "session") {
        entry.visibility = "draft";
      } else {
        current = false;
      }
    });
    await expectWithheld(source, {
      ...(authority === "session" ? { ticket } : {}),
      bytes: operation === "bytes",
    });
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
    const metadata = await expectMetadata(source, { mediaTicket: expect.any(String) });
    expect(metadata.res.statusCode).toBe(200);
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
  await expectBytes(source, {}, Buffer.from(content), "application/pdf");
  const outside = path.join(temp, name);
  await fs.writeFile(outside, content);
  expect((await request(outside, { bytes: true })).res.statusCode).toBe(404);
});

it.each(["tmpfs", "bind", "volume"] as const)(
  "does not read a worktree image hidden by a sandbox %s mount",
  async (kind) => {
    await managedWorkspace();
    cfg.agents!.defaults = {
      sandbox: {
        backend: "docker",
        docker:
          kind === "tmpfs"
            ? { tmpfs: ["/workspace/cache"] }
            : { binds: ["/unverified-engine-source:/workspace/cache:rw"] },
      },
    };
    await image("cache/screenshot.png");
    await mockStoppedWorkspaceContainer(project, "/workspace", [
      {
        Type: kind,
        Source: "/unverified-engine-source",
        Destination: "/workspace/cache",
        RW: true,
      },
    ]);
    for (const source of ["/workspace/cache/screenshot.png", "cache/screenshot.png"]) {
      await expectMetadata(source, { available: false });
      await expectWithheld(source, { bytes: true });
    }
  },
);

it("contains mapped managed sandbox images and revokes tickets when the workspace changes", async () => {
  await managedWorkspace();
  const worktree = entry.worktree!;
  cfg.agents!.defaults = { sandbox: { backend: "podman", docker: { workdir: "/project" } } };
  entry.spawnedCwd = path.join(project, "nested");
  await fs.mkdir(entry.spawnedCwd);
  const local = await image("screenshot.png");
  await mockStoppedWorkspaceContainer(project, "/project");
  const source = "/project/screenshot.png";
  const ticket = await mediaTicket(source);
  await expectBytes(source, { ticket });
  const relativeSource = "../screenshot.png";
  await expectBytes(relativeSource, { ticket: await mediaTicket(relativeSource) });
  await expectWithheld(local, { ticket, bytes: true });
  const outside = await image("outside.png", temp);
  await fs.symlink(outside, path.join(project, "escape.png"));
  for (const denied of ["/project/escape.png", "/project/../outside.png"]) {
    await expectMetadata(denied, { available: false });
    await expectWithheld(denied, { bytes: true });
  }
  {
    using _ = onOpen(local, () => {
      entry.worktree = { ...entry.worktree!, id: "replacement-worktree" };
    });
    await expectWithheld(source, { ticket, bytes: true });
  }
  await expectWithheld(source, { ticket, bytes: true });
  await expectMetadata(source, { available: false });
  entry.worktree = worktree;
  const renewed = await mediaTicket(source);
  await expectBytes(source, { ticket: renewed });
  cfg.agents!.defaults!.sandbox!.docker!.workdir = "/renamed";
  await expectWithheld(source, { ticket: renewed, bytes: true });
});
