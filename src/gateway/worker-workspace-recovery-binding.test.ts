import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueGitRefMutation } from "../infra/git-exec.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { WORKER_PROTOCOL_FEATURES } from "./worker-environments/placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createWorkerSessionPlacementGate } from "./worker-environments/placement-worker-gate.js";
import * as support from "./worker-environments/service.test-support.js";
import type {
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceTunnelHandle,
} from "./worker-environments/tunnel-contract.js";
import { createWorkerTunnelManager } from "./worker-environments/tunnel.js";
import {
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
  WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
} from "./worker-environments/workspace-conflicts.js";
import {
  sha256,
  workspaceManifest,
} from "./worker-environments/workspace-manifest-fixtures.test-support.js";
import { gitInit } from "./worker-environments/workspace-recovery.test-support.js";
import {
  applyStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./worker-environments/workspace-result-staging.js";

const boundary = vi.hoisted(() => ({
  worktreePath: "",
  onReportQueued: undefined as (() => void) | undefined,
  onRefMutationRequested: undefined as (() => void) | undefined,
}));

vi.mock("../agents/worktrees/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/worktrees/service.js")>();
  return {
    ...actual,
    managedWorktrees: {
      findLiveByOwner: async (_kind: string, ownerId: string) => ({
        id: "recovery-worktree",
        ownerId,
        path: boundary.worktreePath,
      }),
    },
  };
});

vi.mock("../infra/git-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/git-exec.js")>();
  return {
    ...actual,
    enqueueGitRefMutation: <T>(...args: Parameters<typeof actual.enqueueGitRefMutation<T>>) => {
      const pending = actual.enqueueGitRefMutation(...args);
      boundary.onRefMutationRequested?.();
      return pending;
    },
  };
});

vi.mock("../config/sessions/session-accessor.sqlite-scope.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.sqlite-scope.js")>();
  return {
    ...actual,
    runExclusiveSqliteSessionWrite: <T>(
      ...args: Parameters<typeof actual.runExclusiveSqliteSessionWrite<T>>
    ) => {
      const pending = actual.runExclusiveSqliteSessionWrite(...args);
      // Observe enqueueing without replacing the real writer or supplying its authority.
      if (args[2] === "session.transcript.report") {
        boundary.onReportQueued?.();
      }
      return pending;
    },
  };
});

function manifest(content?: string) {
  const raw = JSON.stringify(
    workspaceManifest(content === undefined ? {} : { "result.txt": content }),
  );
  return { raw, ref: `sha256:${sha256(raw)}` };
}

const base = manifest();
const workerOutput = "recoverable worker output\n";
const noop = async () => {};

async function stageResult(stagedResultRef: string) {
  const current = manifest(workerOutput);
  const stagingRoot = path.join(support.testState.root, "worker-result");
  await fs.mkdir(stagingRoot);
  await fs.writeFile(path.join(stagingRoot, "result.txt"), workerOutput);
  await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root: boundary.worktreePath,
    stagingRoot,
    stagedResultRef,
    baseManifestRef: base.ref,
    currentManifestRef: current.ref,
    baseManifestRaw: base.raw,
    currentManifestRaw: current.raw,
  });
}

async function applyRecoveryResult(request: WorkerWorkspaceReconcileRequest) {
  assert(request.source.kind === "local" && request.source.stagedResult);
  await stageResult(request.source.stagedResult.ref);
  await request.source.stagedResult.record(request.source.stagedResult.ref);
  await applyStagedWorkerWorkspaceResult({
    root: boundary.worktreePath,
    stagedResultRef: request.source.stagedResult.ref,
    expectedBaseManifestRef: base.ref,
    journal: request.source.journal,
  });
}

async function readRef(ref: string) {
  const result = await runCommandWithTimeout(
    ["git", "-C", boundary.worktreePath, "show-ref", "--verify", ref],
    { timeoutMs: 10_000 },
  );
  expect(result.code).toBe(0);
  return result.stdout;
}

async function readCustomEvents(
  scope: Parameters<typeof loadTranscriptEvents>[0],
  customType: string,
) {
  return (await loadTranscriptEvents(scope)).filter(
    (event) => isRecord(event) && event.customType === customType,
  );
}

type RecoveryFixture = Awaited<ReturnType<typeof createRecoveryFixture>>;

async function withRecovery(verify: (fixture: RecoveryFixture) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ workspaceDir }) => {
    const fixture = await createRecoveryFixture(workspaceDir);
    try {
      await verify(fixture);
    } finally {
      boundary.onReportQueued = undefined;
      boundary.onRefMutationRequested = undefined;
      await fixture.environments.stop();
      resetConfigRuntimeState();
    }
  });
}

async function createRecoveryFixture(workspacePath: string) {
  boundary.worktreePath = workspacePath;
  await gitInit(workspacePath);
  const sessionStore = (name: string) => ({
    agentId: REQUEST.agentId,
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    storePath: path.join(support.testState.root, `sessions-${name}.sqlite`),
  });
  const a = sessionStore("a");
  const b = sessionStore("b");
  const configFor = (storePath: string): OpenClawConfig => ({
    ...support.testState.config,
    agents: { entries: { [REQUEST.agentId]: {} } },
    session: { store: storePath, maintenance: { mode: "warn" } },
  });
  const configA = configFor(a.storePath);
  const configB = configFor(b.storePath);
  setRuntimeConfigSnapshot(configA, configA);
  for (const [index, scope] of [a, b].entries()) {
    await upsertSessionEntryCore(scope, {
      sessionId: REQUEST.sessionId,
      updatedAt: 1,
      lifecycleRevision: "retained-recovery-lifecycle",
      activeWriterRunId: "retained-recovery-writer",
      worktree: { id: "recovery-worktree", branch: "synthetic", repoRoot: workspacePath },
    });
    await replaceTranscriptEvents(scope, [
      { type: "session", id: REQUEST.sessionId, version: CURRENT_SESSION_VERSION },
      {
        type: "custom_message",
        id: `prior-conflict-${index}`,
        parentId: null,
        customType: WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
        content: `Conflict in physical store ${index}`,
        display: true,
        details: {
          paths: ["previous.txt"],
          stagedResultRef: `refs/openclaw/worker-results/previous-${index}`,
          totalCount: 1,
        },
      },
    ]);
  }
  const protocolFeatures = [...WORKER_PROTOCOL_FEATURES];
  support.testState.prepareInstallation = async () => ({
    ...support.BUNDLE_ARTIFACT,
    protocolFeatures,
  });
  const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
  const tunnelManager = createWorkerTunnelManager();
  const destroy = vi.fn(noop);
  const environments = support.createService(support.createProvider({ destroy }), {
    tunnelManager,
    placementStore: createWorkerSessionPlacementGate(placements),
  });
  const environmentId = "worker-recovery-binding";
  const bootstrapping = await support.seedBootstrapping(environmentId, "bundle");
  await support.testState.store.transition({
    environmentId,
    from: bootstrapping.state,
    to: "ready",
    patch: support.readyPatch(environmentId, { ...support.BOOTSTRAP_RECEIPT, protocolFeatures }),
  });
  const attached = await environments.attachSession({
    environmentId,
    ownerEpoch: 1,
    sessionId: REQUEST.sessionId,
  });
  expect(
    await seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: attached.ownerEpoch,
      executionMode: "remote-exec",
    }),
  ).toMatchObject({ state: "active" });
  const claim = await placements.claimTurn({
    ...REQUEST,
    claimId: "recovery-binding-claim",
    runId: "recovery-binding-run",
    owner: { kind: "local", environmentId, ownerEpoch: attached.ownerEpoch },
  });
  await placements.updateWorkspaceBaseManifest({ claim, manifestRef: base.ref });
  await placements.markWorkspaceResultPending(claim);
  await placements.handoffWorkspaceResultRecovery(claim);
  const onReconcile = vi.fn<(request: WorkerWorkspaceReconcileRequest) => Promise<void>>(noop);
  const handle: WorkerWorkspaceTunnelHandle = {
    environmentId,
    ownerEpoch: attached.ownerEpoch,
    runWorkspaceCommand: async () => {
      throw new Error("Unexpected workspace command");
    },
    syncWorkspace: async () => {
      throw new Error("Unexpected workspace sync");
    },
    quiesceWorkspace: async () => ({ assertActive: noop, resume: noop }),
    reconcileWorkspace: async (request) => {
      await onReconcile(request);
      assert(request.source.kind === "local");
      await request.source.journal.commit(base.ref);
      return {
        manifestRef: base.ref,
        changed: false,
        verifyStable: noop,
        verifyLocalStable: noop,
        publishStagedResult: noop,
        discardPreparedStagedResult: noop,
      };
    },
    stop: noop,
  };
  vi.spyOn(tunnelManager, "start").mockResolvedValue(handle);
  const runtime = createGatewayWorkerPlacementRuntime({
    initialPlacements: await placements.listAsync(),
    scheduler: createTestGatewayScheduler(),
    placements,
    environments,
    getCommittedRuntimeConfig: getRuntimeConfig,
    gatewayNamespace: "recovery-binding-test",
    cancelSessionWork: noop,
    revokeSessionAuthority: () => {},
    warn: vi.fn(),
  });
  return { a, b, configB, runtime, placements, environments, destroy, claim, onReconcile };
}

async function readAppliedJournal(placements: RecoveryFixture["placements"]) {
  const owners = await placements.listWorkspaceReconciliationOwners();
  expect(owners).toHaveLength(1);
  const owner = owners[0]!;
  const journal = await placements.loadWorkspaceReconciliation(owner);
  expect(journal?.appliedManifestRef).toBeDefined();
  return { owner, journal };
}

support.setupWorkerEnvironmentServiceSuite();

afterEach(() => {
  boundary.onReportQueued = undefined;
  boundary.onRefMutationRequested = undefined;
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

it("clears only the prepared store when config changes to an identical session during recovery", async () => {
  await withRecovery(async ({ a, b, configB, runtime, placements, onReconcile }) => {
    const beforeB = await loadTranscriptEvents(b);
    expect(loadSessionEntryReadOnly(a)?.lifecycleRevision).toBe(
      loadSessionEntryReadOnly(b)?.lifecycleRevision,
    );
    onReconcile.mockImplementation(async () => setRuntimeConfigSnapshot(configB, configB));

    await runtime.dispatchService.reconcile("startup");

    expect(await readCustomEvents(a, WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE)).toHaveLength(1);
    expect(await loadTranscriptEvents(b)).toEqual(beforeB);
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
  });
});

it.each(["lifecycleRevision", "activeWriterRunId"] as const)(
  "keeps recovery debt when an in-process write changes %s before the next effect",
  async (field) => {
    await withRecovery(async ({ a, runtime, placements, onReconcile }) => {
      const before = await loadTranscriptEvents(a);
      onReconcile.mockImplementation(async (request) => {
        assert(request.source.kind === "local" && request.source.assertCurrent);
        await upsertSessionEntryCore(a, { [field]: "successor" });
        request.source.assertCurrent();
      });

      await runtime.dispatchService.reconcile("startup");

      expect(onReconcile).toHaveBeenCalledOnce();
      await expect(onReconcile.mock.results[0]?.value).rejects.toThrow(
        "Workspace recovery session owner changed",
      );
      expect(await loadTranscriptEvents(a)).toEqual(before);
      const pending = await placements.listPendingWorkspaceResultsAsync();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.workspaceAcceptedAtMs).toBeNull();
    });
  },
);

it.each(["SQL recovery report", "Git conflict retirement"] as const)(
  "retains recovery debt when its claim changes behind the %s writer",
  async (scenario) => {
    await withRecovery(async (fixture) => {
      const { a, runtime, placements, onReconcile, destroy, claim } = fixture;
      const report = scenario === "SQL recovery report";
      const hook = report ? "onReportQueued" : "onRefMutationRequested";
      const priorRef = "refs/openclaw/worker-results/previous-0";
      if (!report) {
        await stageResult(priorRef);
      }
      const beforeRef = report ? undefined : await readRef(priorRef);
      const beforeTranscript = report ? undefined : await loadTranscriptEvents(a);
      const held = createDeferredCore();
      const release = createDeferredCore();
      const queued = createDeferredCore();
      const wait = async () => {
        held.resolve();
        await release.promise;
      };
      let blocker: Promise<void> | undefined;
      onReconcile.mockImplementation(async (request) => {
        if (report) {
          await applyRecoveryResult(request);
        }
        blocker = report
          ? runExclusiveSqliteSessionWrite(
              { agentId: REQUEST.agentId, path: a.storePath },
              wait,
              "session.transcript.batch",
            )
          : enqueueGitRefMutation(boundary.worktreePath, ".git", wait);
        await held.promise;
        boundary[hook] = () => queued.resolve();
        if (report) {
          throw new Error("Remote verification failed after the result was retained");
        }
      });
      const recovering = runtime.dispatchService.reconcile("startup");
      try {
        await Promise.race([
          queued.promise,
          recovering.then(() => {
            throw new Error(`Recovery finished without queueing ${scenario}`);
          }),
        ]);
        boundary[hook] = undefined;
        const pending = await placements.listPendingWorkspaceResultsAsync();
        expect(pending).toHaveLength(1);
        const applied = report ? await readAppliedJournal(placements) : undefined;
        if (!report) {
          expect(pending[0]!.workspaceAcceptedAtMs).not.toBeNull();
        }
        // Replace the durable owner while this process waits on the real writer.
        await placements.clearLocalTurnClaimsAfterRestartAsync();
        await placements.claimTurn({
          ...REQUEST,
          claimId: "replacement-claim",
          runId: "replacement-run",
          owner: claim.owner,
        });
        expect(placements.validateWorkspaceResultClaim(claim)).toBe(false);
        release.resolve();
        await recovering;

        if (applied) {
          expect(await readCustomEvents(a, WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE)).toEqual([]);
          expect(await placements.loadWorkspaceReconciliation(applied.owner)).toEqual(
            applied.journal,
          );
          await readRef(pending[0]!.stagedResultRef!);
          expect(await fs.readFile(path.join(boundary.worktreePath, "result.txt"), "utf8")).toBe(
            workerOutput,
          );
        } else {
          expect(await readRef(priorRef)).toBe(beforeRef);
          expect(await loadTranscriptEvents(a)).toEqual(beforeTranscript);
          expect(placements.get(REQUEST.sessionId)?.turnClaim?.claimId).toBe("replacement-claim");
        }
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        boundary[hook] = undefined;
        release.resolve();
        await blocker;
        await recovering;
      }
    });
  },
);

it("keeps the result in custody when its captured source disappears instead of reporting into a replacement store", async () => {
  await withRecovery(async (fixture) => {
    const { a, b, configB, runtime, placements, onReconcile, destroy } = fixture;
    const beforeB = await loadTranscriptEvents(b);
    const retired = `${a.storePath}.retired`;
    let sourceMoved = false;
    onReconcile.mockImplementation(async (request) => {
      await applyRecoveryResult(request);
      await fs.rename(a.storePath, retired);
      sourceMoved = true;
      setRuntimeConfigSnapshot(configB, configB);
      throw new Error("Captured recovery source was retired during remote verification");
    });
    try {
      await runtime.dispatchService.reconcile("startup");

      expect(sourceMoved).toBe(true);
      expect(await loadTranscriptEvents(b)).toEqual(beforeB);
      const pending = await placements.listPendingWorkspaceResultsAsync();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.workspaceAcceptedAtMs).toBeNull();
      await readAppliedJournal(placements);
      await readRef(pending[0]!.stagedResultRef!);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      if (sourceMoved) {
        await fs.rename(retired, a.storePath);
      }
    }
  });
});
