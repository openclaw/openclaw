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
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

afterEach(() => resetDiagnosticRunActivityForTest());

function environment(environmentId: string, nodeDeviceId = "node-1"): WorkerEnvironmentRecord {
  return {
    environmentId,
    nodeDeviceId,
    providerId: "device",
    profileId: "device:node-1",
    profileSnapshot: {},
    preparation: null,
    provisionOperationId: "provision-1",
    nodeSetupId: null,
    sharedHost: true,
    desktop: null,
    bootstrapReceipt: null,
    ownerEpoch: 1,
    teardownTerminalState: null,
    attachedSessionIds: [environmentId],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    lastActivatedAtMs: null,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    state: "attached",
    leaseId: "lease-1",
    sshEndpoint: null,
  };
}

function placement(
  environmentId: string,
  sessionId = environmentId,
): Extract<WorkerSessionPlacementRecord, { state: "provisioning" }> {
  return {
    sessionId,
    environmentId,
    agentId: "main",
    sessionKey: `agent:main:${sessionId}`,
    state: "provisioning",
    generation: 1,
    executionMode: "worker-turn",
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
}

function createHarness(
  environments: WorkerEnvironmentRecord[],
  records: WorkerSessionPlacementRecord[],
  observations: ReadonlyMap<string, { environmentIds: readonly string[] }> = new Map(),
) {
  const entered = createDeferredCore<readonly string[]>();
  const release = createDeferredCore();
  const published = createDeferredCore();
  const projection: WorkerSessionPlacementProjection = {
    placements: new Map(records.map((record) => [record.sessionId, record])),
    moves: new Map(),
    pendingResults: new Map(),
    workspaceJournalOwnerSessionIds: new Set(),
    environments: new Map(),
    workspaceResultReconcilingSessionIds: new Set(),
    workspaceRecoveryPendingSessionIds: new Set(),
  };
  const readProjection = vi.fn(async (sessionIds: readonly string[]) => {
    entered.resolve(sessionIds);
    await release.promise;
    return {
      ...projection,
      placements: new Map([...projection.placements].filter(([id]) => sessionIds.includes(id))),
    };
  });
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
  return {
    publisher,
    readProjection,
    entered,
    release,
    published,
    events,
    async close() {
      release.resolve();
      await publisher.stop();
      unsubscribe();
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
  try {
    harness.publisher.changed("node-1", []);
    harness.publisher.changed("node-1", []);
    expect(await harness.entered.promise).not.toContain("other-node");
    active.attachedSessionIds = ["active"];
    moved.nodeDeviceId = "node-2";
    harness.release.resolve();
    await harness.published.promise;
    await harness.publisher.stop();
    expect(harness.readProjection).toHaveBeenCalledOnce();
    expect(harness.events).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:active",
      agentId: "main",
      reason: "worker-runtime-install",
      scope: "runtime",
    });
  } finally {
    await harness.close();
  }
});

it("stops pending publication and ignores later changes", async () => {
  const harness = createHarness([environment("active")], [placement("active")]);
  try {
    harness.publisher.changed("node-1", []);
    await harness.entered.promise;
    const stopping = harness.publisher.stop();
    harness.release.resolve();
    await stopping;
    harness.publisher.changed("node-1", []);
    await harness.publisher.stop();
    expect(harness.readProjection).toHaveBeenCalledOnce();
    expect(harness.events).not.toHaveBeenCalled();
  } finally {
    await harness.close();
  }
});

it("touches only observed provisioning activity and leaves refresh waits to turn admission", async () => {
  const waiting: Extract<WorkerSessionPlacementRecord, { state: "active" }> = {
    ...placement("waiting"),
    state: "active",
    environmentId: "waiting",
    activeOwnerEpoch: 1,
    workerBundleHash: "old-build",
    workspaceBaseManifestRef: "sha256:base",
    remoteWorkspaceDir: "/workspace",
  };
  const observed = placement("observed");
  const unobserved = placement("unobserved");
  const records = [waiting, observed, unobserved];
  for (const record of records) {
    markDiagnosticRunProgress({
      sessionId: record.sessionId,
      sessionKey: record.sessionKey,
      reason: "global_lane:waiting",
    });
  }
  const harness = createHarness(
    records.map(({ sessionId }) => environment(sessionId)),
    records,
    new Map([["node-1", { environmentIds: ["observed"] }]]),
  );
  try {
    harness.publisher.changed("node-1", ["observed"]);
    await harness.entered.promise;
    harness.release.resolve();
    await harness.published.promise;
    await harness.publisher.stop();
    expect(harness.events).toHaveBeenCalledTimes(3);
    expect(getDiagnosticSessionActivitySnapshot(observed)).toMatchObject({
      lastProgressReason: "worker:runtime_install",
    });
    for (const record of [waiting, unobserved]) {
      expect(getDiagnosticSessionActivitySnapshot(record)).toMatchObject({
        lastProgressReason: "global_lane:waiting",
      });
    }
  } finally {
    await harness.close();
  }
});

it.each([
  ["in-flight", true],
  ["completed", false],
] as const)(
  "publishes %s provisioning installs before a node lease is committed",
  async (_, inFlight) => {
    const provisioning: WorkerEnvironmentRecord = {
      ...environment("provisioning"),
      state: "provisioning",
      nodeDeviceId: null,
      leaseId: null,
      sshEndpoint: null,
    };
    const record = placement("provisioning");
    markDiagnosticRunProgress({
      sessionId: record.sessionId,
      sessionKey: record.sessionKey,
      reason: "global_lane:waiting",
    });
    const harness = createHarness(
      [
        provisioning,
        { ...provisioning, environmentId: "unrelated", attachedSessionIds: ["unrelated"] },
      ],
      [record, placement("unrelated")],
      // A completed install has no observation left to name its environments.
      inFlight ? new Map([["node-1", { environmentIds: ["provisioning"] }]]) : new Map(),
    );
    try {
      harness.release.resolve();
      harness.publisher.changed("node-1", ["provisioning"]);
      await Promise.resolve();
      expect(harness.readProjection).toHaveBeenCalledWith(["provisioning"], { current: true });
      await harness.published.promise;
      await harness.publisher.stop();
      expect(harness.events).toHaveBeenCalledExactlyOnceWith({
        sessionKey: record.sessionKey,
        agentId: "main",
        reason: "worker-runtime-install",
        scope: "runtime",
      });
      expect(getDiagnosticSessionActivitySnapshot(record)).toMatchObject({
        lastProgressReason: inFlight ? "worker:runtime_install" : "global_lane:waiting",
      });
    } finally {
      await harness.close();
    }
  },
);
