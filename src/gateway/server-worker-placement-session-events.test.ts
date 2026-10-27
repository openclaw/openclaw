import { expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks } = getWorkerPlacementStartupMocks();

import { getRuntimeConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../process/spawn-broker/pipe.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runPublicationCommand } from "./github-publication-git-transport.js";
import {
  createGatewayGitHubPublicationRuntime,
  createGatewayWorkerPlacementRuntime,
} from "./server-worker-placement-startup.js";
import {
  createIdleDiskSpace,
  createRuntimeFactory,
  placementAsyncDefaults,
  setDispatchMock,
  startRuntime as startSidecar,
} from "./server-worker-placement.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { sessionIdentity } from "./worker-environments/placement-suite.test-support.js";

type RuntimeOptions = Parameters<typeof createGatewayWorkerPlacementRuntime>[0];
const createRuntime = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);

async function releaseLocalTurn(
  placements: RuntimeOptions["placements"],
  identity: ReturnType<typeof sessionIdentity>,
) {
  await placements.releaseTurn(
    await placements.claimTurn({
      ...identity,
      claimId: `${identity.sessionId}-claim`,
      runId: `${identity.sessionId}-run`,
      owner: { kind: "local" },
    }),
  );
}

function emitDeletion(databaseIdentity: symbol) {
  emitSessionIdentityMutation({
    kind: "delete",
    agentId: "main",
    databaseIdentity,
    previous: { sessionId: "retired-session", sessionKeys: ["agent:main:retired"] },
  });
}

function startRuntime(
  time: ReturnType<typeof createGatewaySchedulerClock>,
  reconcileActive: () => Promise<void>,
  warn: RuntimeOptions["warn"],
  placements: RuntimeOptions["placements"] = placementAsyncDefaults() as never,
  onReconciled = () => {},
  scheduler = createTestGatewayScheduler(time.clock),
) {
  runtimeFactoryMocks.createDiskSpace.mockReturnValue({
    ...createIdleDiskSpace(),
    version: () => 0,
  });
  setDispatchMock(runtimeFactoryMocks.createDispatch, { reconcileActive });
  const githubPublicationRuntime = createGatewayGitHubPublicationRuntime({
    placements,
    getCommittedRuntimeConfig: getRuntimeConfig,
    warn,
  });
  githubPublicationRuntime.reconcilePublications = async () => onReconciled();
  return startSidecar(
    createRuntime({
      githubPublicationRuntime,
      scheduler,
      placements,
      warn,
    }),
  );
}

it("retires changed placements after real placement and session writes without idle rescans", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const time = createGatewaySchedulerClock();
    const placements = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase(),
    });
    const identity = sessionIdentity("retirement-current");
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    await upsertSessionEntryCore(
      { ...identity, storePath },
      { sessionId: identity.sessionId, updatedAt: Date.now() },
    );
    await releaseLocalTurn(placements, identity);
    const evidence = await vi.importActual<
      typeof import("./server-worker-placement-session-evidence.js")
    >("./server-worker-placement-session-evidence.js");
    runtimeFactoryMocks.createSessionEvidenceResolver.mockImplementation(
      evidence.createWorkerPlacementSessionEvidenceResolver,
    );
    const list = vi.spyOn(placements, "listAsync");
    const reconcileActive = vi.fn(async () => {});
    let reconciled = createDeferredCore();
    const warn = vi.fn();
    const sidecar = await startRuntime(time, reconcileActive, warn, placements, () =>
      reconciled.resolve(),
    );
    try {
      await time.advanceBy(60_000);
      await time.advanceBy(60_000);
      expect(list).toHaveBeenCalledOnce();
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenCalledOnce();
      expect(await placements.getAsync(identity.sessionId)).toMatchObject(identity);

      sessionChanges.emit({ all: true, scope: "worker-placements" });
      sessionChanges.emit({ all: true, scope: "config-presentation" });
      sessionChanges.emit({
        sessionKey: identity.sessionKey,
        scope: "transcript",
        factsInvalidated: true,
      });
      await time.advanceBy(60_000);
      expect(list).toHaveBeenCalledOnce();
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenCalledOnce();

      const invalidations: SessionRowChange[] = [
        { all: true, scope: "config" },
        { ...identity, factsInvalidated: true },
      ];
      for (const [index, change] of invalidations.entries()) {
        sessionChanges.emit(change);
        await time.advanceBy(60_000);
        expect(list).toHaveBeenCalledTimes(2 + index);
      }

      const orphan = sessionIdentity("retirement-orphan");
      await releaseLocalTurn(placements, orphan);
      await time.advanceBy(60_000);
      expect(await placements.getAsync(orphan.sessionId)).toBeUndefined();
      expect(await placements.getAsync(identity.sessionId)).toMatchObject(identity);
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenLastCalledWith(
        [expect.objectContaining(orphan)],
        expect.any(AbortSignal),
      );
      expect(list).toHaveBeenCalledTimes(3);

      reconciled = createDeferredCore();
      const recoveriesBeforeDeletion = reconcileActive.mock.calls.length;
      await deleteSessionEntryLifecycle({
        agentId: identity.agentId,
        storePath,
        archiveTranscript: false,
        target: { canonicalKey: identity.sessionKey, storeKeys: [identity.sessionKey] },
      });
      await reconciled.promise;
      expect(reconcileActive).toHaveBeenCalledTimes(recoveriesBeforeDeletion);
      expect(await placements.getAsync(identity.sessionId)).toBeUndefined();
      expect(runtimeFactoryMocks.createSessionEvidenceResolver).toHaveBeenLastCalledWith(
        [expect.objectContaining(identity)],
        expect.any(AbortSignal),
      );
      expect(list).toHaveBeenCalledTimes(3);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await sidecar?.stop();
    }
  }));

it("finishes background reconciliation after the notifying session request closes", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const time = createGatewaySchedulerClock();
    const broker = supportsSpawnBrokerCommandTransport() ? createSpawnBrokerHost() : undefined;
    await broker?.ready();
    const placements = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase(),
    });
    const completed = createDeferredCore<boolean>();
    let reconciled = createDeferredCore();
    const parents: string[] = [];
    const retirementReads = vi.fn(async () => {
      try {
        await placements.readRecoveryCandidates();
        const result = await runPublicationCommand([
          process.execPath,
          "-e",
          "process.stdout.write(String(process.ppid))",
        ]);
        expect(result.code).toBe(0);
        parents.push(result.stdout.toString());
        completed.resolve(true);
        return new Map();
      } catch (error) {
        completed.resolve(false);
        throw error;
      }
    });
    const reconcileActive = vi.fn(async () => {});
    vi.spyOn(placements, "getManyAsync").mockImplementation(retirementReads);
    const warn = vi.fn();
    const sidecar = await runWithSpawnBroker(broker, () =>
      startRuntime(time, reconcileActive, warn, placements, () => reconciled.resolve()),
    );
    try {
      await reconciled.promise;
      reconciled = createDeferredCore();
      const request = new AsyncWorkScope();
      runWithSpawnBroker(undefined, () =>
        request.run(() => emitDeletion(Symbol("session-database"))),
      );
      await request.drain();
      expect(await completed.promise).toBe(true);
      await reconciled.promise;
      expect(retirementReads).toHaveBeenCalledOnce();
      expect(reconcileActive).not.toHaveBeenCalled();
      expect(parents).toEqual([String(broker?.pid ?? process.pid)]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await sidecar?.stop();
      await broker?.close();
    }
  }));

it("reports a failed reconciliation queued by a session change without leaking rejection", async () => {
  const time = createGatewaySchedulerClock();
  const releaseReconcile = createDeferredCore();
  const reconcileStarted = createDeferredCore();
  const failureReported = createDeferredCore();
  const reconcileActive = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const warn = vi.fn(() => failureReported.resolve());
  const retirementReads = vi.fn(async () => {
    throw new Error("Worker environment inventory has closed");
  });
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  vi.spyOn(placements, "getManyAsync").mockImplementation(retirementReads);
  const sidecar = await startRuntime(time, reconcileActive, warn, placements);
  let scheduledWake: void | Promise<void> = undefined;
  try {
    await time.advanceBy(60_000);
    expect(warn).not.toHaveBeenCalled();
    reconcileActive.mockClear();
    reconcileActive.mockImplementationOnce(() => {
      reconcileStarted.resolve();
      return releaseReconcile.promise;
    });
    scheduledWake = time.advanceBy(60_000);
    await reconcileStarted.promise;
    expect(reconcileActive).toHaveBeenCalledOnce();
    emitDeletion(Symbol("worker-placement-database"));
    releaseReconcile.resolve();
    await failureReported.promise;
    expect(reconcileActive).toHaveBeenCalledOnce();
    expect(retirementReads).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Worker placement reconcile sweep failed: Worker environment inventory has closed",
    );
  } finally {
    releaseReconcile.resolve();
    await sidecar?.stop();
    await scheduledWake;
  }
});

it("coalesces concurrent full recovery requests into the pending full pass", async () => {
  const time = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(time.clock);
  const scope = scheduler.scope();
  vi.spyOn(scheduler, "scope").mockReturnValue(scope);
  const schedule = vi.spyOn(scope, "schedule");
  const reconcileStarted = createDeferredCore();
  const releaseReconcile = createDeferredCore();
  const reconcileActive = vi.fn(async () => {});
  const warn = vi.fn();
  const sidecar = await startRuntime(time, reconcileActive, warn, undefined, undefined, scheduler);
  const requests: Promise<unknown>[] = [];
  try {
    await time.advanceBy(60_000);
    reconcileActive.mockClear();
    reconcileActive.mockImplementationOnce(() => {
      reconcileStarted.resolve();
      return releaseReconcile.promise;
    });
    const sweep = schedule.mock.calls.find(([job]) => job.id === "worker-placements:reconcile")![0]
      .run;
    requests.push(Promise.resolve(sweep()));
    await reconcileStarted.promise;
    requests.push(Promise.resolve(sweep()), Promise.resolve(sweep()), Promise.resolve(sweep()));
    releaseReconcile.resolve();
    await Promise.all(requests);
    expect(reconcileActive).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    releaseReconcile.resolve();
    await Promise.all(requests);
    await sidecar?.stop();
  }
});

it("runs the periodic recovery after an in-flight identity-only pass", async () => {
  const time = createGatewaySchedulerClock();
  const retirementStarted = createDeferredCore();
  const releaseRetirement = createDeferredCore();
  const reconcileActive = vi.fn(async () => {});
  const warn = vi.fn();
  let reconciled = createDeferredCore();
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  vi.spyOn(placements, "getManyAsync").mockImplementation(async () => {
    retirementStarted.resolve();
    await releaseRetirement.promise;
    return new Map();
  });
  const sidecar = await startRuntime(time, reconcileActive, warn, placements, () =>
    reconciled.resolve(),
  );
  let scheduledWake: void | Promise<void> = undefined;
  try {
    await reconciled.promise;
    reconciled = createDeferredCore();
    emitDeletion(Symbol("worker-placement-database"));
    await retirementStarted.promise;
    scheduledWake = time.advanceBy(60_000);
    expect(reconcileActive).not.toHaveBeenCalled();
    releaseRetirement.resolve();
    await scheduledWake;
    expect(reconcileActive).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    releaseRetirement.resolve();
    await scheduledWake;
    await sidecar?.stop();
  }
});
