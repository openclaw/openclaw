import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
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
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
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
  applyStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./worker-environments/workspace-result-staging.js";

const boundary = vi.hoisted(() => ({
  worktreePath: "",
  onReportQueued: undefined as (() => void) | undefined,
  onReportCompleted: undefined as (() => void) | undefined,
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
    enqueueGitRefMutation: <T>(
      cwd: string,
      commonDirectory: string,
      run: () => Promise<T>,
      signal?: AbortSignal,
    ) => {
      const pending = actual.enqueueGitRefMutation(cwd, commonDirectory, run, signal);
      boundary.onRefMutationRequested?.();
      return pending;
    },
  };
});

vi.mock("../config/sessions/session-accessor.sqlite-scope.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-accessor.sqlite-scope.js")>();
  type Write = typeof actual.runExclusiveSqliteSessionWrite;
  return {
    ...actual,
    runExclusiveSqliteSessionWrite: <T>(
      scope: Parameters<Write>[0],
      run: () => Promise<T>,
      operation: Parameters<Write>[2],
      diagnostics?: Parameters<Write>[3],
      writer?: Parameters<Write>[4],
    ) => {
      const pending = actual.runExclusiveSqliteSessionWrite(
        scope,
        run,
        operation,
        diagnostics,
        writer,
      );
      // Observe enqueueing without replacing the real writer or supplying its authority.
      if (operation === "session.transcript.report") {
        boundary.onReportQueued?.();
        return pending.then((result) => {
          boundary.onReportCompleted?.();
          return result;
        });
      }
      return pending;
    },
  };
});

function manifest(content?: string) {
  const raw = JSON.stringify({
    version: 1,
    baseCommit: null,
    entries:
      content === undefined
        ? []
        : [
            {
              path: "result.txt",
              type: "file",
              mode: 0o644,
              size: Buffer.byteLength(content),
              sha256: createHash("sha256").update(content).digest("hex"),
            },
          ],
  });
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

async function stageResult(stagedResultRef: string, base: ReturnType<typeof manifest>) {
  const current = manifest("recoverable worker output\n");
  const stagingRoot = path.join(support.testState.root, "worker-result");
  await fs.mkdir(stagingRoot);
  await fs.writeFile(path.join(stagingRoot, "result.txt"), "recoverable worker output\n");
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

async function applyRecoveryResult(
  request: WorkerWorkspaceReconcileRequest,
  base: ReturnType<typeof manifest>,
) {
  if (request.source.kind !== "local" || !request.source.stagedResult) {
    throw new Error("Expected staged local recovery");
  }
  await stageResult(request.source.stagedResult.ref, base);
  await request.source.stagedResult.record(request.source.stagedResult.ref);
  await applyStagedWorkerWorkspaceResult({
    root: boundary.worktreePath,
    stagedResultRef: request.source.stagedResult.ref,
    expectedBaseManifestRef: base.ref,
    journal: request.source.journal,
  });
}

function readRef(ref: string) {
  return runCommandWithTimeout(["git", "-C", boundary.worktreePath, "show-ref", "--verify", ref], {
    timeoutMs: 10_000,
  });
}

async function readCustomEvents(
  scope: Parameters<typeof loadTranscriptEvents>[0],
  customType: string,
) {
  return (await loadTranscriptEvents(scope)).filter(
    (event) => isRecord(event) && event.customType === customType,
  );
}

async function withRecovery(
  options: { archived?: boolean },
  verify: (fixture: Awaited<ReturnType<typeof createRecoveryFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ workspaceDir }) => {
    const fixture = await createRecoveryFixture(workspaceDir, options);
    try {
      await verify(fixture);
    } finally {
      boundary.onReportQueued = undefined;
      boundary.onReportCompleted = undefined;
      boundary.onRefMutationRequested = undefined;
      await fixture.environments.stop();
      resetConfigRuntimeState();
    }
  });
}

async function createRecoveryFixture(workspacePath: string, options: { archived?: boolean }) {
  boundary.worktreePath = workspacePath;
  const initialized = await runCommandWithTimeout(["git", "-C", workspacePath, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(initialized.code).toBe(0);
  const stores = ["a", "b"].map((name) => ({
    agentId: REQUEST.agentId,
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    storePath: path.join(support.testState.root, `sessions-${name}.sqlite`),
  }));
  const [a, b] = stores;
  if (!a || !b) {
    throw new Error("Missing recovery session stores");
  }
  const configFor = (storePath: string): OpenClawConfig => ({
    ...support.testState.config,
    agents: { entries: { [REQUEST.agentId]: {} } },
    session: { store: storePath, maintenance: { mode: "warn" } },
  });
  const configA = configFor(a.storePath);
  const configB = configFor(b.storePath);
  setRuntimeConfigSnapshot(configA, configA);
  for (const [index, scope] of stores.entries()) {
    await upsertSessionEntryCore(scope, {
      sessionId: REQUEST.sessionId,
      updatedAt: 1,
      lifecycleRevision: "retained-recovery-lifecycle",
      activeWriterRunId: "retained-recovery-writer",
      ...(options.archived ? { archivedAt: 100 } : {}),
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
  const protocolFeatures = [
    WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
    WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  ];
  support.testState.prepareInstallation = async () => ({
    ...support.BUNDLE_ARTIFACT,
    protocolFeatures,
  });
  const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
  const tunnelManager = createWorkerTunnelManager();
  const destroy = vi.fn(async () => {});
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
  const active = await seedActivePlacement(placements, {
    environmentId,
    ownerEpoch: attached.ownerEpoch,
    executionMode: "remote-exec",
  });
  if (active.state !== "active") {
    throw new Error("Recovery fixture did not activate");
  }
  const claim = await placements.claimTurn({
    ...REQUEST,
    claimId: "recovery-binding-claim",
    runId: "recovery-binding-run",
    owner: { kind: "local", environmentId, ownerEpoch: attached.ownerEpoch },
  });
  const base = manifest();
  await placements.updateWorkspaceBaseManifest({ claim, manifestRef: base.ref });
  await placements.markWorkspaceResultPending(claim);
  await placements.handoffWorkspaceResultRecovery(claim);
  const onReconcile = vi.fn<(request: WorkerWorkspaceReconcileRequest) => Promise<void>>(
    async () => {},
  );
  const handle: WorkerWorkspaceTunnelHandle = {
    environmentId,
    ownerEpoch: attached.ownerEpoch,
    runWorkspaceCommand: async () => {
      throw new Error("Unexpected workspace command");
    },
    syncWorkspace: async () => {
      throw new Error("Unexpected workspace sync");
    },
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    reconcileWorkspace: async (request) => {
      await onReconcile(request);
      if (request.source.kind !== "local") {
        throw new Error("Expected local workspace recovery");
      }
      await request.source.journal.commit(base.ref);
      return {
        manifestRef: base.ref,
        changed: false,
        verifyStable: async () => {},
        verifyLocalStable: async () => {},
        publishStagedResult: async () => {},
        discardPreparedStagedResult: async () => {},
      };
    },
    stop: async () => {},
  };
  vi.spyOn(tunnelManager, "start").mockResolvedValue(handle);
  const runtime = createGatewayWorkerPlacementRuntime({
    initialPlacements: await placements.listAsync(),
    scheduler: createTestGatewayScheduler(),
    placements,
    environments,
    getCommittedRuntimeConfig: getRuntimeConfig,
    gatewayNamespace: "recovery-binding-test",
    cancelSessionWork: async () => {},
    revokeSessionAuthority: () => {},
    warn: vi.fn(),
  });
  return { a, b, configB, runtime, placements, environments, destroy, claim, onReconcile, base };
}

describe("registered worker workspace recovery target binding", () => {
  support.setupWorkerEnvironmentServiceSuite();

  afterEach(() => {
    boundary.onReportQueued = undefined;
    boundary.onReportCompleted = undefined;
    boundary.onRefMutationRequested = undefined;
    resetConfigRuntimeState();
    vi.restoreAllMocks();
  });

  it("clears only the prepared store when config changes to an identical session during recovery", async () => {
    await withRecovery({}, async ({ a, b, configB, runtime, placements, onReconcile }) => {
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

  it("settles recovery and appends its conflict clear without reopening an archived session", async () => {
    await withRecovery({ archived: true }, async ({ a, b, runtime, placements, destroy }) => {
      const beforeB = await loadTranscriptEvents(b);

      await runtime.dispatchService.reconcile("startup");
      await runtime.dispatchService.reconcile("startup");

      expect(loadSessionEntryReadOnly(a)?.archivedAt).toBe(100);
      expect(await readCustomEvents(a, WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE)).toHaveLength(1);
      expect(await loadTranscriptEvents(b)).toEqual(beforeB);
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "active", turnClaim: null });
      expect(destroy).not.toHaveBeenCalled();
    });
  });

  it("keeps repeated mutation guards payload-free while unrelated conversations keep writing", async () => {
    await withRecovery({}, async ({ a, runtime, placements, onReconcile }) => {
      const unrelatedKey = "agent:main:unrelated-recovery";
      await upsertSessionEntryCore(
        { ...a, sessionKey: unrelatedKey },
        { sessionId: "unrelated-session", updatedAt: 1 },
      );
      await upsertSessionEntryCore(a, { label: "x".repeat(1024 * 1024) });
      let observed: { stableReads: number; returnedTextBytes: number } | undefined;
      onReconcile.mockImplementation(async (request) => {
        if (request.source.kind !== "local" || !request.source.assertCurrent) {
          throw new Error("Expected a guarded local recovery");
        }
        const assertCurrent = request.source.assertCurrent;
        const retained = retainOpenClawAgentDatabaseReadOnly({
          agentId: a.agentId,
          path: a.storePath,
        });
        if (!retained.found) {
          throw new Error("Recovery test store is unavailable");
        }
        const foreign = new DatabaseSync(retained.database.path);
        const reads = trackSqliteStatementExecutions(retained.database.db, ["session"], (sql) =>
          sql.includes('from "session_nodes"') ? "session" : null,
        );
        try {
          for (let index = 0; index < 100; index += 1) {
            assertCurrent();
          }
          const stableReads = reads.counts.session;
          const update = foreign.prepare(
            "UPDATE session_nodes SET display_name = ? WHERE session_key = ?",
          );
          await runExclusiveSqliteSessionWrite(
            { agentId: a.agentId, path: retained.database.path },
            async () => {
              for (let index = 0; index < 20; index += 1) {
                update.run(`unrelated-${index}`, unrelatedKey);
                assertCurrent();
              }
            },
            "session-entry.patch",
          );
          observed = { stableReads, returnedTextBytes: reads.textBytes.session };
        } finally {
          reads.restore();
          foreign.close();
          retained.claim.release();
        }
      });

      await runtime.dispatchService.reconcile("startup");

      expect(onReconcile).toHaveBeenCalledOnce();
      await expect(onReconcile.mock.results[0]?.value).resolves.toBeUndefined();
      expect(observed).toEqual({ stableReads: 0, returnedTextBytes: 0 });
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    });
  });

  it.each(["guarded", "unrelated"] as const)(
    "rechecks a %s conversation write interleaved with its committed report",
    async (changed) => {
      await withRecovery({}, async ({ a, runtime, placements, onReconcile }) => {
        const unrelatedKey = "agent:main:unrelated-report";
        await upsertSessionEntryCore(
          { ...a, sessionKey: unrelatedKey },
          { sessionId: "unrelated-report-session", updatedAt: 1 },
        );
        const foreign = new DatabaseSync(a.storePath);
        const replaceWriter = foreign.prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.activeWriterRunId', ?) WHERE session_key = ?",
        );
        onReconcile.mockImplementation(async () => {
          boundary.onReportCompleted = () => {
            replaceWriter.run(
              "foreign-writer",
              changed === "guarded" ? a.sessionKey : unrelatedKey,
            );
          };
        });
        try {
          await runtime.dispatchService.reconcile("startup");

          expect(
            await readCustomEvents(a, WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE),
          ).toHaveLength(1);
          const pending = await placements.listPendingWorkspaceResultsAsync();
          if (changed === "guarded") {
            expect(pending).toHaveLength(1);
            expect(pending[0]?.workspaceAcceptedAtMs).not.toBeNull();
          } else {
            expect(pending).toEqual([]);
          }
        } finally {
          boundary.onReportCompleted = undefined;
          foreign.close();
        }
      });
    },
  );

  it("rejects a queued recovery report after durable claim replacement and keeps its recovery debt", async () => {
    await withRecovery(
      {},
      async ({ a, runtime, placements, claim, onReconcile, base, destroy }) => {
        const held = createDeferredCore();
        const release = createDeferredCore();
        const queued = createDeferredCore();
        let blocker: Promise<void> | undefined;
        onReconcile.mockImplementation(async (request) => {
          await applyRecoveryResult(request, base);
          blocker = runExclusiveSqliteSessionWrite(
            { agentId: REQUEST.agentId, path: a.storePath },
            async () => {
              held.resolve();
              await release.promise;
            },
            "session.transcript.batch",
          );
          await held.promise;
          boundary.onReportQueued = () => queued.resolve();
          throw new Error("Remote verification failed after the result was retained");
        });
        const recovering = runtime.dispatchService.reconcile("startup");
        try {
          await Promise.race([
            queued.promise,
            recovering.then(() => {
              throw new Error("Recovery finished without queueing its transcript report");
            }),
          ]);
          boundary.onReportQueued = undefined;
          const pending = await placements.listPendingWorkspaceResultsAsync();
          const journalOwners = await placements.listWorkspaceReconciliationOwners();
          expect(pending).toHaveLength(1);
          expect(journalOwners).toHaveLength(1);
          const owner = journalOwners[0]!;
          const journal = await placements.loadWorkspaceReconciliation(owner);
          expect(journal?.appliedManifestRef).toBeDefined();
          // Model a replacement owner after restart while this process waits on its writer.
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

          expect(await readCustomEvents(a, WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE)).toEqual([]);
          expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
          expect(await placements.loadWorkspaceReconciliation(owner)).toEqual(journal);
          const ref = await readRef(pending[0]!.stagedResultRef!);
          expect(ref.code).toBe(0);
          expect(await fs.readFile(path.join(boundary.worktreePath, "result.txt"), "utf8")).toBe(
            "recoverable worker output\n",
          );
          expect(destroy).not.toHaveBeenCalled();
        } finally {
          boundary.onReportQueued = undefined;
          release.resolve();
          await blocker;
          await recovering;
        }
      },
    );
  });

  it("preserves a superseded conflict ref when its recovery claim changes behind the Git writer", async () => {
    await withRecovery(
      {},
      async ({ a, runtime, placements, claim, onReconcile, base, destroy }) => {
        const priorRef = "refs/openclaw/worker-results/previous-0";
        await stageResult(priorRef, base);
        const beforeRef = await readRef(priorRef);
        expect(beforeRef.code).toBe(0);
        const beforeTranscript = await loadTranscriptEvents(a);
        const held = createDeferredCore();
        const release = createDeferredCore();
        const requested = createDeferredCore();
        let blocker: Promise<void> | undefined;
        onReconcile.mockImplementation(async () => {
          blocker = enqueueGitRefMutation(boundary.worktreePath, ".git", async () => {
            held.resolve();
            await release.promise;
          });
          await held.promise;
          boundary.onRefMutationRequested = () => requested.resolve();
        });
        const recovering = runtime.dispatchService.reconcile("startup");
        try {
          await Promise.race([
            requested.promise,
            recovering.then(() => {
              throw new Error("Recovery finished without requesting conflict ref retirement");
            }),
          ]);
          boundary.onRefMutationRequested = undefined;
          const pending = await placements.listPendingWorkspaceResultsAsync();
          expect(pending).toHaveLength(1);
          expect(pending[0]!.workspaceAcceptedAtMs).not.toBeNull();
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

          const afterRef = await readRef(priorRef);
          expect(afterRef.code).toBe(0);
          expect(afterRef.stdout).toBe(beforeRef.stdout);
          expect(await loadTranscriptEvents(a)).toEqual(beforeTranscript);
          expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
          expect(placements.get(REQUEST.sessionId)?.turnClaim?.claimId).toBe("replacement-claim");
          expect(destroy).not.toHaveBeenCalled();
        } finally {
          boundary.onRefMutationRequested = undefined;
          release.resolve();
          await blocker;
          await recovering;
        }
      },
    );
  });

  it("keeps the result in custody when its captured source disappears instead of reporting into a replacement store", async () => {
    await withRecovery(
      {},
      async ({ a, b, configB, runtime, placements, onReconcile, base, destroy }) => {
        const beforeB = await loadTranscriptEvents(b);
        const retired = `${a.storePath}.retired`;
        let sourceMoved = false;
        onReconcile.mockImplementation(async (request) => {
          await applyRecoveryResult(request, base);
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
          const owners = await placements.listWorkspaceReconciliationOwners();
          expect(owners).toHaveLength(1);
          expect(
            (await placements.loadWorkspaceReconciliation(owners[0]!))?.appliedManifestRef,
          ).toBeDefined();
          const ref = await readRef(pending[0]!.stagedResultRef!);
          expect(ref.code).toBe(0);
          expect(destroy).not.toHaveBeenCalled();
        } finally {
          if (sourceMoved) {
            await fs.rename(retired, a.storePath);
          }
        }
      },
    );
  });
});
