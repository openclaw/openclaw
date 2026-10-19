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
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { withSessionTranscriptDeltaReader } from "../../config/sessions/session-transcript-delta-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { WORKSPACE_INSPECTION_COMMAND } from "../../worker/workspace-inspection-protocol.js";
import {
  readGitHubRepositoryPublicationBlob,
  readGitHubRepositoryPublicationMetadata,
  REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
} from "../github-repository-publication-snapshot.js";
import { nodeWorkerGatewayNamespace } from "../worker-environments/node-worker-gateway-namespace.js";
import {
  BUILD,
  createManager,
  environment,
  transport,
  workspaceTransfer,
} from "../worker-environments/node-worker-tunnel.test-support.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "../worker-environments/placement-test-fixtures.js";
import { createRepositoryWorkspaceMutationService } from "../worker-environments/repository-workspace-mutation.js";
import type { WorkerEnvironmentService } from "../worker-environments/service.js";
import {
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "../worker-environments/session-repository-checkpoints.js";
import type {
  WorkerWorkspaceCommand,
  WorkerWorkspaceReconcileRequest,
} from "../worker-environments/tunnel-contract.js";
import { captureWorkspaceManifest } from "../worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "../worker-environments/workspace-manifest.js";
import { createWorkerWorkspaceOperationCoordinator } from "../worker-environments/workspace-operation-coordinator.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import { loadSessionDiff } from "./sessions-diff.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createSessionFilesClient,
  createSessionFileDownloadClient,
  fetchSessionFileDownload,
  openSessionFileDownload,
  createWorkspaceFixture,
  expectOkPayload,
  hashContent,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  workspace: vi.fn(),
  store: vi.fn(),
  open: vi.fn(),
  beforeWrite: vi.fn<() => Promise<void>>(),
}));
vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    mocks.load(params.key, { agentId: params.agentId }),
}));
vi.mock("../../config/sessions/session-entry-read-facts.js", async (original) => {
  const { createRepositorySessionEntryReader } =
    await import("./sessions-files.repository.test-support.js");
  const actual =
    await original<typeof import("../../config/sessions/session-entry-read-facts.js")>();
  return {
    ...actual,
    readRetainedSessionEntryFacts: createRepositorySessionEntryReader(
      actual.readRetainedSessionEntryFacts,
      () => mocks.load(),
    ),
  };
});
vi.mock("../../infra/fs-safe.js", async (original) => {
  const actual = await original<typeof import("../../infra/fs-safe.js")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const root = await actual.root(...args);
      const write = root.write.bind(root);
      root.write = async (...writeArgs) => {
        await mocks.beforeWrite();
        await write(...writeArgs);
      };
      return root;
    },
  };
});
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
const repositoryEntry = () => ({
  sessionId,
  repositoryWorkspaceId: source.workspaceId,
  lifecycleRevision,
  archivedAt,
});
const environmentRecord = () => ({
  ...environment(),
  environmentId: identity.environmentId,
  ownerEpoch: identity.generation,
  attachedSessionIds: [identity.sessionId],
});

function checkpointData(base: Awaited<ReturnType<typeof capture>>, current = base) {
  return {
    stagingRoot: workspace,
    baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
    currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
    baseManifestRef: base.manifestRef,
    currentManifestRef: current.manifestRef,
  };
}

const createRepository = (url: string) =>
  store.create({ agentId: "main", sessionKey, url, assertCurrent() {} });
async function publishCheckpoint(base: Awaited<ReturnType<typeof capture>>, current = base) {
  const staged = await stageSessionRepositoryCheckpoint({
    store,
    workspaceId: source.workspaceId,
    expectedRevision: source.revision,
    ...checkpointData(base, current),
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
  mocks.load.mockImplementation(() => ({
    agentId: "main",
    canonicalKey: sessionKey,
    cfg: {},
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    storeKeys: [sessionKey],
    entry: repositoryEntry(),
  }));
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
    { ...repositoryEntry(), updatedAt: Date.now() },
  );
}

async function withCheckpointAcceptance(failCapture = false) {
  const database = openOpenClawStateDatabase({ path: path.join(gatewayRoot, "state.sqlite") });
  const placements = createWorkerSessionPlacementStore({ database });
  const placement = await advancePlacementFixtureToActive(
    placements,
    database,
    {
      sessionId: identity.sessionId,
      sessionKey,
      agentId: "main",
      executionMode: "remote-exec",
    },
    {
      environmentId: identity.environmentId,
      ownerEpoch: identity.generation,
      workerBundleHash: BUILD.bundleHash,
      workspaceBaseManifestRef: source.baseManifestHash!,
      remoteWorkspaceDir: workspace,
      seedEnvironment: "before-dispatch",
    },
  );
  generation = placement.generation;
  const base = await capture();
  const environments = {
    get: (): ReturnType<WorkerEnvironmentService["get"]> => ({
      ...environmentRecord(),
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "connected",
    }),
    startTunnel: async () => ({
      ...(await context.workerEnvironmentService.startTunnel()),
      stop: async () => {},
      syncWorkspace: vi.fn(),
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      reconcileWorkspace: async (request: WorkerWorkspaceReconcileRequest) => {
        if (failCapture) {
          throw new Error("checkpoint capture failed");
        }
        if (request.source.kind !== "repository") {
          throw new Error("expected repository capture");
        }
        const current = await capture();
        const publicationStagingRoot = path.join(nodeRoot, "publication");
        const publicationDigest = execFileSync(
          process.execPath,
          [
            "-e",
            REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
            workspace,
            source.baseCommit!,
            publicationStagingRoot,
          ],
          { encoding: "utf8" },
        ).trim();
        const prepared = await request.source.prepareCheckpoint({
          ...checkpointData(base, current),
          publicationStagingRoot,
          publicationDigest,
        });
        return {
          manifestRef: current.manifestRef,
          changed: current.manifestRef !== base.manifestRef,
          verifyStable: async () => {
            expect((await capture()).manifestRef).toBe(current.manifestRef);
          },
          verifyLocalStable: () => prepared.verify(),
          publishStagedResult: async () => {
            await prepared.publish();
          },
          discardPreparedStagedResult: () => prepared.discard(),
        };
      },
    }),
  };
  const service = createRepositoryWorkspaceMutationService({
    placements,
    environments,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    resolveWorkspace: async () => ({
      kind: "repository",
      repository: (await store.get(source.workspaceId))!,
    }),
  });
  return { placements, context: { ...context, workerRepositoryWorkspaceMutationService: service } };
}

it("accepts editor bytes and Git-normalized publication before acknowledging the save", async () => {
  const accepted = await withCheckpointAcceptance();
  writeFile(".gitattributes", "changed.txt text eol=lf\n");
  await files.ok("set", edit("saved\r\n"), accepted.context);
  await withSessionRepositoryCheckpoint(
    { store, workspaceId: source.workspaceId, includePublication: true },
    async ({ stagingRoot, publicationDigest, publicationStagingRoot }) => {
      expect(fs.readFileSync(path.join(stagingRoot, "changed.txt"), "utf8")).toBe("saved\r\n");
      expect(publicationDigest).toBeDefined();
      const { snapshot: publication } = await readGitHubRepositoryPublicationMetadata(
        publicationStagingRoot!,
        publicationDigest!,
      );
      const published = publication.entries.find((entry) => entry.path === "changed.txt")!;
      expect(
        (
          await readGitHubRepositoryPublicationBlob(publicationStagingRoot!, published.sha!)
        ).toString(),
      ).toBe("saved\n");
    },
  );
  expect(await accepted.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  expect(accepted.placements.get(identity.sessionId)?.turnClaim).toBeNull();
});

it("reports failed editor checkpoint capture and retains the durable recovery owner", async () => {
  const accepted = await withCheckpointAcceptance(true);
  await expect(files.request("set", edit("saved\n"), accepted.context)).rejects.toThrow(
    "checkpoint capture failed",
  );
  expect(readFile("changed.txt")).toBe("saved\n");
  expect(await store.get(source.workspaceId)).toMatchObject({
    checkpointRef: source.checkpointRef,
    manifestHash: source.manifestHash,
  });
  expect(await accepted.placements.listPendingWorkspaceResultsAsync()).toEqual([
    expect.objectContaining({
      sessionId: identity.sessionId,
      workspaceAcceptedAtMs: null,
      recoveryRequestedAtMs: expect.any(Number),
    }),
  ]);
});

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
  const fetched = await fetchSessionFileDownload(connection.client, download.url);
  expect(fetched.response.statusCode).toBe(200);
  expect(Buffer.from(fetched.body as Uint8Array).toString()).toBe("untouched source\n");
  memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
  expect(
    (await fetchSessionFileDownload(connection.client, download.url)).response.statusCode,
  ).toBe(404);
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
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
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
  expect(
    (await fetchSessionFileDownload(connection.client, download.url)).response.statusCode,
  ).toBe(404);
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it("browses, previews, edits and diffs only the live repository without a Gateway checkout", async () => {
  const list = await files.ok("list");
  const listedPaths = list.browser.entries.map((entry: { path: string }) => entry.path);
  expect(listedPaths).toContain("README");
  expect(listedPaths).not.toContain("package.json");
  expect(list.root).toBeUndefined();
  const before = await files.ok("get", "changed.txt");
  const content = "x".repeat(192 * 1024);
  await files.ok("set", edit(content, before.file.hash));
  const saved = await files.ok("get", "changed.txt");
  expect(saved.file).toMatchObject({ content, hash: hashContent(content) });
  expect(saved.root).toBeUndefined();
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
  const reveal = await files.ok("reveal");
  expect(reveal).toMatchObject({
    ok: false,
    error: expect.stringContaining("no Gateway checkout"),
  });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it.each(["tunnel", "result"])("rejects a replaced placement after %s work", async (phase) => {
  if (phase === "tunnel") {
    onTunnel = () => {
      generation++;
    };
  } else {
    onResult = () => {
      generation++;
    };
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
    await expect(files.request("set", edit("unowned"))).rejects.toThrow("owner changed");
    expect(run).not.toHaveBeenCalled();
    expect(readFile("changed.txt")).toBe("before\n");
  },
);

it.each(["stop", "reset"])(
  "retains the editor owner through a delayed file commit before %s",
  async (mutation) => {
    const writing = createDeferredCore();
    const releaseWrite = createDeferredCore();
    mocks.beforeWrite.mockImplementationOnce(async () => {
      writing.resolve();
      await releaseWrite.promise;
    });
    const saving = invoke(
      "sessions.files.set",
      {
        sessionKey,
        path: "changed.txt",
        content: "saved\n",
        expectedHash: hashContent("before\n"),
      },
      context,
    );
    await writing.promise;
    let mutationEntered = false;
    let contentAtMutation: string | undefined;
    const mutating = runSessionMutation({
      scope: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
      identities: [sessionKey, identity.sessionId],
      run: async () => {
        mutationEntered = true;
        contentAtMutation = fs.readFileSync(path.join(workspace, "changed.txt"), "utf8");
        if (mutation === "stop") {
          active = false;
        } else {
          sessionId = "replacement";
        }
      },
    });
    // Observe the independently queued lifecycle operation after its microtasks drain.
    // The filesystem delay is explicit; no elapsed-time assumption controls the race.
    try {
      await setImmediate();
      expect(mutationEntered).toBe(false);
    } finally {
      releaseWrite.resolve();
      await Promise.allSettled([saving, mutating]);
    }
    expectOkPayload(await saving);
    await mutating;
    expect(mutationEntered).toBe(true);
    expect(contentAtMutation).toBe("saved\n");
  },
);

it("keeps stopped inspection limited to verified changed artifacts", async () => {
  const changedPaths = ["changed.txt", "oversized.txt", "second.txt"];
  const oversizedBytes = Buffer.alloc(8 * 1024 * 1024 + 1, 97);
  const base = await capture();
  writeFile("changed.txt", "retained first\n");
  writeFile("second.txt", "retained second\n");
  writeFile("oversized.txt", oversizedBytes);
  await publishCheckpoint(base, await capture());
  active = false;
  const originalGitRead = worktreeGit.runGitBuffered;
  const hostReads = vi.spyOn(worktreeGit, "runGitBuffered");
  onTestFinished(() => hostReads.mockRestore());
  const list = await files.ok("list");
  expect(list.browser.entries.map((entry: { path: string }) => entry.path)).toEqual(changedPaths);
  expect(hostReads.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
    ["cat-file", "commit"],
    ["ls-tree", "-r"],
  ]);
  for (const call of hostReads.mock.calls) {
    expect(call[2]).toMatchObject({ signal: expect.any(AbortSignal), killProcessTree: true });
  }
  const retained = await files.ok("get", "second.txt");
  expect(retained.file.content).toBe("retained second\n");
  expect(retained.file.hash).toBeUndefined();
  expect(retained.root).toBeUndefined();
  const blobsRead = () => hostReads.mock.calls.filter(([, args]) => args[1] === "--batch").length;
  using connection = createSessionFileDownloadClient();
  const download = await files.ok("download", "oversized.txt", undefined, connection);
  const fetched = await fetchSessionFileDownload(connection.client, download.url);
  expect(fetched.response.statusCode).toBe(200);
  expect(Buffer.from(fetched.body as Uint8Array).equals(oversizedBytes)).toBe(true);
  await files.error("download", "README", undefined, connection);
  await files.error("download", "../changed.txt", undefined, connection);
  const beforeOversized = blobsRead();
  expect(beforeOversized).toBeGreaterThan(0);
  const oversized = await files.error("get", "oversized.txt");
  expect(oversized).toEqual({
    code: "INVALID_REQUEST",
    message: "session file is too large to preview",
    details: {
      type: "session_file_too_large",
      path: "oversized.txt",
      maxPreviewBytes: WORKSPACE_PREVIEW_MAX_BYTES,
      size: oversizedBytes.length,
    },
  });
  expect(blobsRead()).toBe(beforeOversized);
  await expect(files.request("get", "README")).rejects.toThrow("not a retained changed artifact");
  const diff = await loadSessionDiff({ sessionKey }, context as never);
  expect(diff.unavailableReason).toBe("workspace_stopped");
  expect(diff.files.map((file) => file.path)).toEqual(changedPaths);
  expect(run).not.toHaveBeenCalled();
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
  await expect(files.request("get", "second.txt")).rejects.toThrow(
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
  await expect(files.request("get", "second.txt")).rejects.toThrow("workspace owner changed");
});

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
  const record = environmentRecord();
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
    scope: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
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
