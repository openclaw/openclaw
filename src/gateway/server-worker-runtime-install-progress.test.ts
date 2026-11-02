import { afterEach, expect, it, vi } from "vitest";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
} from "../logging/diagnostic-run-activity.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createWorkerRuntimeInstallProgressPublisher } from "./server-worker-runtime-install-progress.js";
import type { WorkerEnvironmentRecord } from "./worker-environments/environment-record.js";
import { createDispatchEnvironmentFixtures } from "./worker-environments/placement-dispatch-test-fixtures.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import {
  activePlacement,
  localPlacement,
} from "./worker-environments/placement-suite.test-support.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  resetDiagnosticRunActivityForTest();
});

function environment(environmentId: string, nodeDeviceId = "node-1"): WorkerEnvironmentRecord {
  return {
    ...createDispatchEnvironmentFixtures().attached,
    environmentId,
    nodeDeviceId,
    attachedSessionIds: [environmentId],
  };
}

function placement(environmentId: string, sessionId = environmentId) {
  return { ...localPlacement(sessionId), environmentId, state: "provisioning" as const };
}

function markWaiting(record: WorkerSessionPlacementRecord) {
  markDiagnosticRunProgress({
    sessionId: record.sessionId,
    sessionKey: record.sessionKey,
    reason: "global_lane:waiting",
  });
}

function expectPublished(events: ReturnType<typeof vi.fn>, sessionKey: string) {
  expect(events).toHaveBeenCalledExactlyOnceWith({
    sessionKey,
    agentId: "main",
    reason: "worker-runtime-install",
    scope: "runtime",
  });
}

function createHarness(
  environments: WorkerEnvironmentRecord[],
  records: WorkerSessionPlacementRecord[],
  observations: ReadonlyMap<string, { environmentIds: readonly string[] }> = new Map(),
) {
  const entered = createDeferredCore<readonly string[]>();
  const release = createDeferredCore();
  const published = createDeferredCore();
  const readProjection = vi.fn(
    async (sessionIds: readonly string[]): Promise<WorkerSessionPlacementProjection> => {
      entered.resolve(sessionIds);
      await release.promise;
      return {
        placements: new Map(
          records
            .filter((record) => sessionIds.includes(record.sessionId))
            .map((record) => [record.sessionId, record]),
        ),
        moves: new Map(),
        pendingResults: new Map(),
        workspaceJournalOwnerSessionIds: new Set(),
        environments: new Map(),
        workspaceResultReconcilingSessionIds: new Set(),
        workspaceRecoveryPendingSessionIds: new Set(),
      };
    },
  );
  const events = vi.fn(() => published.resolve());
  const unsubscribe = onSessionLifecycleEvent(events);
  const publisher = createWorkerRuntimeInstallProgressPublisher({
    environments: {
      listForReconcile: () => environments,
      get: (id) => environments.find((record) => record.environmentId === id),
    },
    placements: { readProjection },
    readInstall: (nodeId) => observations.get(nodeId),
    warn: vi.fn(),
  });
  cleanups.push(async () => {
    release.resolve();
    await publisher.stop();
    unsubscribe();
  });
  return {
    publisher,
    readProjection,
    entered,
    release,
    events,
    async finish() {
      release.resolve();
      await published.promise;
      await publisher.stop();
    },
  };
}

it("coalesces changes and emits only for sessions still attached to the node's non-terminal environments", async () => {
  const active = environment("active");
  active.attachedSessionIds.push("detached");
  const moved = environment("moved");
  const environments: WorkerEnvironmentRecord[] = [
    active,
    moved,
    environment("other-node", "node-2"),
    { ...environment("destroyed"), state: "destroyed", leaseId: "lease-1" },
    { ...environment("orphaned"), state: "orphaned", leaseId: "lease-1" },
    { ...environment("failed"), state: "failed", leaseId: null, sshEndpoint: null },
  ];
  const harness = createHarness(environments, [
    ...environments.map(({ environmentId }) => placement(environmentId)),
    placement("active", "detached"),
  ]);
  harness.publisher.changed("node-1", []);
  harness.publisher.changed("node-1", []);
  expect(await harness.entered.promise).not.toContain("other-node");
  active.attachedSessionIds = ["active"];
  moved.nodeDeviceId = "node-2";
  await harness.finish();
  expect(harness.readProjection).toHaveBeenCalledOnce();
  expectPublished(harness.events, "agent:main:active");
});

it("stops pending publication and ignores later changes", async () => {
  const harness = createHarness([environment("active")], [placement("active")]);
  harness.publisher.changed("node-1", []);
  await harness.entered.promise;
  const stopping = harness.publisher.stop();
  harness.release.resolve();
  await stopping;
  harness.publisher.changed("node-1", []);
  await harness.publisher.stop();
  expect(harness.readProjection).toHaveBeenCalledOnce();
  expect(harness.events).not.toHaveBeenCalled();
});

it("touches only observed provisioning activity and leaves refresh waits to turn admission", async () => {
  const waiting = activePlacement("waiting", { environmentId: "waiting" });
  const observed = placement("observed");
  const unobserved = placement("unobserved");
  const records = [waiting, observed, unobserved];
  records.forEach(markWaiting);
  const harness = createHarness(
    records.map(({ sessionId }) => environment(sessionId)),
    records,
    new Map([["node-1", { environmentIds: ["observed"] }]]),
  );
  harness.publisher.changed("node-1", ["observed"]);
  await harness.entered.promise;
  await harness.finish();
  expect(harness.events).toHaveBeenCalledTimes(3);
  expect(
    records.map((record) => getDiagnosticSessionActivitySnapshot(record)?.lastProgressReason),
  ).toEqual(["global_lane:waiting", "worker:runtime_install", "global_lane:waiting"]);
});

it.each([true, false])(
  "publishes provisioning installs before lease commitment (in flight: %s)",
  async (inFlight) => {
    const provisioning: WorkerEnvironmentRecord = {
      ...environment("provisioning"),
      state: "provisioning",
      nodeDeviceId: null,
      leaseId: null,
      sshEndpoint: null,
    };
    const record = placement("provisioning");
    markWaiting(record);
    const harness = createHarness(
      [
        provisioning,
        { ...provisioning, environmentId: "unrelated", attachedSessionIds: ["unrelated"] },
      ],
      [record, placement("unrelated")],
      inFlight ? new Map([["node-1", { environmentIds: ["provisioning"] }]]) : new Map(),
    );
    harness.release.resolve();
    harness.publisher.changed("node-1", ["provisioning"]);
    await Promise.resolve();
    expect(harness.readProjection).toHaveBeenCalledWith(["provisioning"], { current: true });
    await harness.finish();
    expectPublished(harness.events, record.sessionKey);
    expect(getDiagnosticSessionActivitySnapshot(record)).toMatchObject({
      lastProgressReason: inFlight ? "worker:runtime_install" : "global_lane:waiting",
    });
  },
);
