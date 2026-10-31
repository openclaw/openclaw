import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import * as worktreeGit from "../../agents/worktrees/git.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { withSessionTranscriptDeltaReader } from "../../config/sessions/session-transcript-delta-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { WORKSPACE_INSPECTION_COMMAND } from "../../worker/workspace-inspection-protocol.js";
import { nodeWorkerGatewayNamespace } from "../worker-environments/node-worker-gateway-namespace.js";
import {
  BUILD,
  createManager,
  environment,
  transport,
  workspaceTransfer,
} from "../worker-environments/node-worker-tunnel.test-support.js";
import { stageSessionRepositoryCheckpoint } from "../worker-environments/session-repository-checkpoints.js";
import type { WorkerWorkspaceCommand } from "../worker-environments/tunnel-contract.js";
import { captureWorkspaceManifest } from "../worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "../worker-environments/workspace-manifest.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import { loadSessionDiff } from "./sessions-diff.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createSessionFilesClient,
  createSessionFileDownloadClient,
  openSessionFileDownload,
  createWorkspaceFixture,
  hashContent,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  store: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../agents/agent-scope.js", async (original) => ({
  ...(await original<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: mocks.workspace,
}));
vi.mock("../../state/session-repository-workspaces.js", async (original) => ({
  ...(await original<typeof import("../../state/session-repository-workspaces.js")>()),
  getSessionRepositoryWorkspaceStore: mocks.store,
}));
vi.mock("./open-path.js", async (original) => ({
  ...(await original<typeof import("./open-path.js")>()),
  execOpenPath: mocks.open,
}));
// mock-isolation: Repository file tests have no transcript; exercise workspace policy without SQLite history.
vi.mock("../../config/sessions/session-transcript-delta-read.js", () => ({
  withSessionTranscriptDeltaReader: ((_scope, consume) =>
    consume({
      visible: async () => ({ kind: "missing" }),
      raw: async () => {
        throw new Error("File browsing must consume visible transcript pages");
      },
    })) satisfies typeof withSessionTranscriptDeltaReader,
}));

const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const files = createSessionFilesClient(invoke, () => ({ sessionKey, context }));
let sessionKey = "agent:main:repository";
const gatewayDeviceId = "repository-gateway";
const identity = {
  gatewayNamespace: nodeWorkerGatewayNamespace(gatewayDeviceId),
  environmentId: "test-environment",
  sessionId: "test-session",
  generation: 1,
};
let gatewayRoot: string;
let nodeRoot: string;
let workspace: string;
let store: ReturnType<typeof createSessionRepositoryWorkspaceStore>;
let source: Awaited<ReturnType<typeof store.create>>;
let runtime: NodeWorkerWorkspaceRuntime;
let generation: number;
let active: boolean;
let onTunnel: (() => void | Promise<void>) | undefined;
let onResult: (() => void) | undefined;
let sessionId: string;
let lifecycleRevision: string;
let archivedAt: number | undefined;
let run: ReturnType<
  typeof vi.fn<(command: WorkerWorkspaceCommand) => ReturnType<NodeWorkerWorkspaceRuntime["exec"]>>
>;
let context: ReturnType<typeof requestContext>;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
}

const workspaceFile = (name: string) => path.join(workspace, name);
const readFile = (name: string) => fs.readFileSync(workspaceFile(name), "utf8");
const writeFile = (name: string, content: string | Buffer) =>
  fs.writeFileSync(workspaceFile(name), content);
const capture = (baseCommit = source.baseCommit) =>
  captureWorkspaceManifest({ root: workspace, baseCommit });
const edit = (content = "saved\n", expectedHash = hashContent("before\n")) => ({
  path: "changed.txt",
  content,
  expectedHash,
});
const createRepository = (url: string) =>
  store.create({ agentId: "main", sessionKey, url, assertCurrent() {} });
async function publishCheckpoint(base: Awaited<ReturnType<typeof capture>>, current = base) {
  const staged = await stageSessionRepositoryCheckpoint({
    store,
    workspaceId: source.workspaceId,
    expectedRevision: source.revision,
    stagingRoot: workspace,
    baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
    currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
    baseManifestRef: base.manifestRef,
    currentManifestRef: current.manifestRef,
    assertCurrent() {},
  });
  source = await staged.publish();
}
async function bindBase(baseCommit: string, baseManifestHash: string) {
  source = await store.bindBase({
    workspaceId: source.workspaceId,
    expectedRevision: source.revision,
    baseCommit,
    baseManifestHash,
    assertCurrent() {},
  });
}

function requestContext() {
  return {
    logGateway: createSubsystemLogger("test/repository-files"),
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
    workerRepositoryWorkspaceMutationService: {
      mutate: async <T>(params: {
        assertCurrent: () => void;
        mutate: (assertCurrent: () => void) => Promise<{ changed: boolean; value: T }>;
      }): Promise<T> => (await params.mutate(params.assertCurrent)).value,
    },
    workerSessionPlacementService: {
      getMany: () =>
        new Map([
          [
            identity.sessionId,
            {
              sessionId: identity.sessionId,
              sessionKey,
              agentId: "main",
              state: active ? "active" : "reclaimed",
              generation,
              environmentId: identity.environmentId,
              activeOwnerEpoch: 1,
              remoteWorkspaceDir: workspace,
            },
          ],
        ]),
    },
    workerEnvironmentService: {
      get: () => ({ state: "attached", ownerEpoch: 1, attachedSessionIds: [identity.sessionId] }),
      startTunnel: async () => {
        await onTunnel?.();
        return { environmentId: identity.environmentId, ownerEpoch: 1, runWorkspaceCommand: run };
      },
    },
  };
}

beforeEach(async () => {
  sessionKey = "agent:main:repository";
  vi.clearAllMocks();
  gatewayRoot = createWorkspaceFixture("repository-files-gateway-");
  vi.stubEnv("OPENCLAW_STATE_DIR", gatewayRoot);
  nodeRoot = createWorkspaceFixture("repository-files-node-");
  generation = 1;
  active = true;
  sessionId = identity.sessionId;
  lifecycleRevision = "original";
  archivedAt = undefined;
  onTunnel = undefined;
  onResult = undefined;
  runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(nodeRoot, "runtime"),
    env: { PATH: process.env.PATH, HOME: nodeRoot },
  });
  workspace = (await runtime.exec({ ...identity, argv: ["git", "init", "-q", "-b", "main"] }))
    .workspaceDir;
  git("config", "user.name", "Repository Test");
  git("config", "user.email", "repository@example.test");
  git("config", "commit.gpgsign", "false");
  writeFile("README", "untouched source\n");
  writeFile("changed.txt", "before\n");
  git("add", ".");
  git("commit", "-qm", "base");
  store = createSessionRepositoryWorkspaceStore({ path: path.join(gatewayRoot, "state.sqlite") });
  source = await createRepository("https://example.test/repository.git");
  const base = await capture(git("rev-parse", "HEAD"));
  await bindBase(base.manifest.baseCommit!, base.manifestRef);
  await publishCheckpoint(base);
  mocks.store.mockReturnValue(store);
  mocks.workspace.mockReturnValue(gatewayRoot);
  context = requestContext();
  setRuntimeConfigSnapshot(context.getRuntimeConfig());
  await persistSessionEntry();
  run = vi.fn(async (command: WorkerWorkspaceCommand) => {
    command.assertCurrent?.();
    const input = parseNodeWorkerWorkspaceExecInput(
      JSON.stringify({ ...identity, argv: command.argv, input: command.input }),
    );
    const result = await runtime.exec(input);
    onResult?.();
    return result;
  });
});

afterEach(async () => {
  await closeOpenClawStateDatabaseByPathAsync(path.join(gatewayRoot, "state.sqlite"));
  await closeOpenClawAgentDatabasesAsync(gatewayRoot);
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  removeWorkspaceFixture(nodeRoot);
  removeWorkspaceFixture(gatewayRoot);
});

async function persistSessionEntry() {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId,
      repositoryWorkspaceId: source.workspaceId,
      lifecycleRevision,
      archivedAt,
      updatedAt: Date.now(),
    },
  );
}

it("keeps incognito repository downloads alive after their RPC planning borrow ends", async () => {
  using connection = createSessionFileDownloadClient();
  const baseCommit = source.baseCommit!;
  const baseManifestHash = source.baseManifestHash!;
  sessionKey = "agent:main:dashboard:incognito-repository-download";
  source = await createRepository("https://example.test/private.git");
  await bindBase(baseCommit, baseManifestHash);
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
  onTestFinished(() =>
    memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath }),
  );
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      sessionId,
      updatedAt: 1,
      incognito: true,
      repositoryWorkspaceId: source.workspaceId,
      lifecycleRevision,
    },
  );
  const download = await files.ok("download", "README", undefined, connection);
  const fetched = await connection.fetch(download.url);
  expect(fetched.response.statusCode).toBe(200);
  expect(Buffer.from(fetched.body as Uint8Array).toString()).toBe("untouched source\n");
  memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
  expect((await connection.fetch(download.url)).response.statusCode).toBe(404);
});

it("downloads original live repository bytes in bounded windows and rejects stale placement", async () => {
  using connection = createSessionFileDownloadClient();
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 3, 0xff);
  writeFile("binary.zip", bytes);
  const download = await files.ok("download", "binary.zip", undefined, connection);
  expect(download.filename).toBe("binary.zip");
  // The RPC prepares metadata without reading any file bytes.
  expect(run.mock.calls.every(([command]) => JSON.parse(command.input!).offset === undefined)).toBe(
    true,
  );
  const nextWindow = createDeferredCore();
  onTestFinished(() => nextWindow.resolve());
  const readWindow = run.getMockImplementation()!;
  run.mockImplementation(async (command) => {
    const { offset } = JSON.parse(command.input!);
    if (offset > 0) {
      await nextWindow.promise;
    }
    return readWindow(command);
  });
  const response = await openSessionFileDownload(connection.client, download.url);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.value!.length).toBeGreaterThan(0);
  expect(Buffer.from(first.value!).equals(bytes.subarray(0, first.value!.length))).toBe(true);
  nextWindow.resolve();
  const chunks = [first.value!];
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(next.value);
  }
  expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  const windows = await Promise.all(run.mock.results.map((call) => call.value));
  expect(windows.every((result) => Buffer.byteLength(result.stdout) < 2 * 1024 * 1024)).toBe(true);
  for (const filePath of ["../outside", "/etc/passwd"]) {
    await files.error("download", filePath, undefined, connection);
  }
  onResult = () => {
    generation++;
  };
  expect((await connection.fetch(download.url)).response.statusCode).toBe(404);
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it("browses, previews, edits and diffs only the live repository without a Gateway checkout", async () => {
  const list = await files.ok("list");
  const listedPaths = list.browser.entries.map((entry: { path: string }) => entry.path);
  expect(listedPaths).toContain("README");
  expect(listedPaths).not.toContain("package.json");
  expect(list.root).toBeUndefined();
  const before = await files.ok("get", "changed.txt");
  expect(before.source).toEqual({ workspaceId: source.workspaceId, root: null, fileRoot: null });
  const content = "x".repeat(192 * 1024);
  await files.ok("set", { ...edit(content, before.file.hash), expectedSource: before.source });
  const saved = await files.ok("get", "changed.txt");
  expect(saved.file).toMatchObject({ content, hash: hashContent(content) });
  expect(saved.root).toBeUndefined();
  expect(saved.source).toEqual(before.source);
  await expect(
    files.request("set", {
      ...edit("wrong repository", saved.file.hash),
      expectedSource: { ...before.source, workspaceId: "different-repository" },
    }),
  ).rejects.toMatchObject({ error: { details: { type: "session_file_source_changed" } } });
  expect((await files.ok("get", "changed.txt")).file.content).toBe(content);
  const stale = await files.error("set", edit("stale", before.file.hash));
  expect(stale.details.type).toBe("session_file_conflict");
  writeFile("changed.txt", "after\n");
  git("add", ".");
  git("commit", "-qm", "session change");
  writeFile("second.txt", "second edit\n");
  const diff = await loadSessionDiff({ sessionKey }, context as never);
  expect(diff.root).toBeUndefined();
  expect(diff.files).toMatchObject([
    { path: "changed.txt", patch: expect.stringContaining("+after") },
    { path: "second.txt", patch: expect.stringContaining("+second edit") },
  ]);
  const summary = await loadSessionDiff({ sessionKey, summaryOnly: true }, context as never);
  expect(summary.root).toBeUndefined();
  expect(summary.files).toEqual([
    { path: "changed.txt", status: "modified", additions: 1, deletions: 1 },
    { path: "second.txt", status: "added", additions: 1, deletions: 0, untracked: true },
  ]);
  expect(summary.additions).toBe(2);
  expect(summary.deletions).toBe(1);
  expect(summary.commits).toBeUndefined();
  expect(await files.ok("reveal")).toMatchObject({
    ok: false,
    error: expect.stringContaining("no Gateway checkout"),
  });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it.each(["tunnel", "result"])("rejects a replaced placement after %s work", async (phase) => {
  const replace = () => {
    generation++;
  };
  if (phase === "tunnel") {
    onTunnel = replace;
  } else {
    onResult = replace;
  }
  await expect(files.request("get", "README")).rejects.toThrow("placement changed");
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it.each(["reset", "archive", "lifecycle revision"])(
  "rejects a session %s before dispatching an editor write",
  async (change) => {
    onTunnel = async () => {
      if (change === "reset") {
        sessionId = "replacement";
      } else if (change === "archive") {
        archivedAt = Date.now();
      } else {
        lifecycleRevision = `${lifecycleRevision}-next`;
      }
      await persistSessionEntry();
    };
    await expect(files.request("set", edit("unowned"))).rejects.toMatchObject({
      name: "SessionMutationAuthorizationChangedError",
      error: {
        code: "FORBIDDEN",
        message: "Session workspace changed during file access",
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(readFile("changed.txt")).toBe("before\n");
  },
);

it("searches stopped repository artifacts using equivalent sigma forms", async () => {
  const base = await capture();
  const retainedPath = "ΕΛΕΓΧΟΣ/README.md";
  fs.mkdirSync(workspaceFile("ΕΛΕΓΧΟΣ"));
  writeFile(retainedPath, "retained Greek report\n");
  await publishCheckpoint(base, await capture());
  active = false;
  for (const search of ["Σ", "σ", "ς"]) {
    const found = await files.ok("list", { search });
    expect(found.browser.entries.map((entry: { path: string }) => entry.path)).toEqual([
      retainedPath,
    ]);
    expect(found.browser).not.toHaveProperty("truncated");
  }
  expect((await files.ok("get", retainedPath)).file.content).toBe("retained Greek report\n");
  expect(run).not.toHaveBeenCalled();
});

it.each(["second-München.txt", "second-Mu\u0308nchen.txt"])(
  "keeps stopped inspection limited to verified changed artifacts (%s)",
  async (storedName) => {
    const changedPaths = ["changed.txt", "oversized.txt", storedName];
    const oversizedBytes = Buffer.alloc(8 * 1024 * 1024 + 1, 97);
    const base = await capture();
    writeFile("changed.txt", "retained first\n");
    writeFile(storedName, "retained second\n");
    writeFile("oversized.txt", oversizedBytes);
    await publishCheckpoint(base, await capture());
    expect((await files.error("get", "oversized.txt")).details).toEqual({
      type: "session_file_too_large",
      maxPreviewBytes: WORKSPACE_PREVIEW_MAX_BYTES,
      path: "oversized.txt",
      size: oversizedBytes.length,
      source: { workspaceId: source.workspaceId, root: null, fileRoot: null },
    });
    expect(run).toHaveBeenCalledOnce();
    active = false;
    const originalGitRead = worktreeGit.runGitBuffered;
    using hostReads = vi.spyOn(worktreeGit, "runGitBuffered");
    const list = await files.ok("list");
    expect(list.browser.entries.map((entry: { path: string }) => entry.path)).toEqual(changedPaths);
    const search = storedName.normalize(storedName === storedName.normalize("NFC") ? "NFD" : "NFC");
    const found = await files.ok("list", { search });
    expect(found.browser.entries.map((entry: { path: string }) => entry.path)).toEqual([
      storedName,
    ]);
    const retained = await files.ok("get", storedName);
    expect(retained.file.content).toBe("retained second\n");
    expect(retained.file.hash).toBeUndefined();
    expect(retained.root).toBeUndefined();
    expect(retained.source).toEqual({
      workspaceId: source.workspaceId,
      root: null,
      fileRoot: null,
    });
    const blobsRead = () => hostReads.mock.calls.filter(([, args]) => args[1] === "--batch").length;
    using connection = createSessionFileDownloadClient();
    const download = await files.ok("download", "oversized.txt", undefined, connection);
    const fetched = await connection.fetch(download.url);
    expect(fetched.response.statusCode).toBe(200);
    expect(Buffer.from(fetched.body as Uint8Array).equals(oversizedBytes)).toBe(true);
    await files.error("download", "README", undefined, connection);
    await files.error("download", "../changed.txt", undefined, connection);
    const beforeOversized = blobsRead();
    expect(beforeOversized).toBeGreaterThan(0);
    expect(await files.error("get", "oversized.txt")).toEqual({
      code: "INVALID_REQUEST",
      message: "session file is too large to preview",
      details: {
        type: "session_file_too_large",
        path: "oversized.txt",
        maxPreviewBytes: WORKSPACE_PREVIEW_MAX_BYTES,
        size: oversizedBytes.length,
        source: retained.source,
      },
    });
    expect(blobsRead()).toBe(beforeOversized);
    await expect(files.request("get", "README")).rejects.toThrow("not a retained changed artifact");
    const diff = await loadSessionDiff({ sessionKey }, context as never);
    expect(diff.unavailableReason).toBe("workspace_stopped");
    expect(diff.files.map((file) => file.path)).toEqual(changedPaths);
    expect(run).toHaveBeenCalledOnce();
    expect(mocks.workspace).not.toHaveBeenCalled();

    hostReads.mockImplementation(async (...args) => {
      const result = await originalGitRead(...args);
      if (args[1][1] !== "--batch") {
        return result;
      }
      const stdout = Buffer.from(result.stdout);
      const contentStart = stdout.indexOf(0x0a) + 1;
      stdout[contentStart] = stdout[contentStart]! ^ 0xff;
      return { ...result, stdout };
    });
    await expect(files.request("get", storedName)).rejects.toThrow(
      "staged result payload is invalid",
    );
    hostReads.mockImplementation(async (...args) => {
      const result = await originalGitRead(...args);
      if (args[1][1] === "--batch") {
        lifecycleRevision = `${lifecycleRevision}-next`;
        await persistSessionEntry();
      }
      return result;
    });
    expect(await files.error("get", storedName)).toEqual({
      code: "FORBIDDEN",
      message: "Session workspace changed during file access",
    });
  },
);

it.each(["symlink", "hardlink"])(
  "does not expose an outside %s through remote preview or diff",
  async (kind) => {
    const outside = path.join(nodeRoot, "outside.txt");
    fs.writeFileSync(outside, "outside marker\n");
    if (kind === "symlink") {
      fs.symlinkSync(outside, path.join(workspace, "link.txt"));
    } else {
      fs.linkSync(outside, path.join(workspace, "link.txt"));
    }
    await files.error("get", "link.txt");
    await files.error("get", "../outside.txt");
    const diff = await loadSessionDiff({ sessionKey }, context as never);
    expect(JSON.stringify(diff)).not.toContain("outside marker");
  },
);

it("keeps a timed-out remote save owned until its physical write drains before Stop", async () => {
  const writing = createDeferredCore();
  const releaseWrite = createDeferredCore();
  const draining = createDeferredCore();
  const target = fs.realpathSync(path.join(workspace, "changed.txt"));
  const realRename = fs.promises.rename.bind(fs.promises);
  const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
    if (args[1] === target) {
      // Hold publication after its final authorization check has dispatched it.
      writing.resolve();
      await releaseWrite.promise;
    }
    return await realRename(...args);
  });
  onTestFinished(() => renameSpy.mockRestore());
  const record = {
    ...environment(),
    environmentId: identity.environmentId,
    ownerEpoch: identity.generation,
    attachedSessionIds: [identity.sessionId],
  };
  const nodeTransport = transport();
  let physicalWrite: Promise<unknown> | undefined;
  nodeTransport.invoke = async (request) => {
    expect(request.isDispatchAuthorized()).toBe(true);
    request.onDispatchReady?.("editor-timeout-invoke");
    const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
    if (input.argv[0] === WORKSPACE_INSPECTION_COMMAND) {
      const cancelled = new AbortController();
      physicalWrite = withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () =>
        runtime.exec(input, cancelled.signal),
      );
      void physicalWrite.catch(() => undefined);
      await writing.promise;
      // The real transport sends cancellation and returns before the node write joins.
      cancelled.abort();
      return { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
    }
    expect(input.argv).toEqual([NODE_WORKSPACE_DRAIN_COMMAND]);
    if (physicalWrite) {
      draining.resolve();
    }
    return { ok: true, payloadJSON: JSON.stringify(await runtime.exec(input, request.signal)) };
  };
  const manager = createManager(record, {
    gatewayDeviceId,
    getTransport: () => nodeTransport,
    workspaceTransfer: { ...workspaceTransfer(), prepareRepository: vi.fn(async () => {}) },
  });
  manager.bindWorkspaceBindingResolver(async () => ({
    source: {
      kind: "repository",
      baseCommit: source.baseCommit!,
      baseManifestRef: source.baseManifestHash!,
    },
    manifestRef: source.baseManifestHash!,
    remoteWorkspaceDir: workspace,
  }));
  const managerContext = {
    ...context,
    workerEnvironmentService: {
      ...context.workerEnvironmentService,
      startTunnel: () =>
        manager.start({
          executionMode: "remote-exec",
          environmentId: identity.environmentId,
          ownerEpoch: identity.generation,
          sessionId: identity.sessionId,
          deviceId: record.nodeDeviceId!,
          expectedBuild: BUILD,
        }),
    },
  };
  let saveSettled = false;
  const saving = files
    .request("set", edit(), managerContext)
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      saveSettled = true;
    });
  await draining.promise;
  let stopEntered = false;
  let contentAtStop: string | undefined;
  const stopping = runSessionMutation({
    scope: resolveDefaultSessionStorePath("main"),
    identities: [sessionKey, identity.sessionId],
    run: async () => {
      stopEntered = true;
      await manager.stop(identity.environmentId, identity.generation);
      contentAtStop = readFile("changed.txt");
      active = false;
    },
  });
  try {
    await setImmediate();
    expect(saveSettled).toBe(false);
    expect(stopEntered).toBe(false);
    expect(readFile("changed.txt")).toBe("before\n");
  } finally {
    releaseWrite.resolve();
    await Promise.allSettled([saving, stopping, physicalWrite]);
  }
  expect(await saving).toEqual(
    expect.objectContaining({ message: expect.stringContaining("TIMEOUT") }),
  );
  await stopping;
  expect(contentAtStop).toBe("saved\n");
  expect(manager.status(identity.environmentId)).toBe("stopped");
});
