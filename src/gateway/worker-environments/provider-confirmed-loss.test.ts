import { assert, expect, it } from "vitest";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { createRemoteExecPlacementSandbox } from "./placement-sandbox.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { providerService } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";

support.setupWorkerEnvironmentServiceSuite();
const session = {
  agentId: "main",
  sessionId: "confirmed-loss",
  sessionKey: "agent:main:confirmed-loss",
  executionMode: "remote-exec" as const,
};
type Placements = ReturnType<typeof createWorkerSessionPlacementStore>;
type Active = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

const placements = () =>
  createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });

async function activate(
  store: Placements,
  requested: WorkerSessionPlacementRecord,
  environmentId: string,
) {
  await support.seedReadyNodeDesktop(environmentId);
  const environment = await support.testState.store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: { ...support.attachedPatch(environmentId, session.sessionId), sharedHost: false },
  });
  let current = await store.transition({
    sessionId: session.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: requested.generation,
    patch: { environmentId },
  });
  current = await store.transition({
    sessionId: session.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: current.generation,
    patch: { workerBundleHash: support.BUNDLE_HASH },
  });
  current = await store.transition({
    sessionId: session.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: current.generation,
    patch: {
      workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir: "/worker/workspace",
    },
  });
  const active = await store.transition({
    sessionId: session.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: current.generation,
    patch: { activeOwnerEpoch: environment.ownerEpoch },
  });
  assert(active.state === "active");
  return active;
}

async function failOwned(store: Placements, active: Active) {
  const owner = {
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
  };
  const draining = await store.startDrain({ ...owner, expectedGeneration: active.generation });
  const reconciling = await store.startReconcile({
    ...owner,
    expectedGeneration: draining.generation,
  });
  return store.fail({
    sessionId: active.sessionId,
    expectedGeneration: reconciling.generation,
    recoveryError: "Provider teardown settled",
  });
}

it("persists provider-confirmed lineage through restart, failed-spare retry and native sandbox projection", async () => {
  let store = placements();
  const active = await activate(store, await store.startDispatch(session), "lost-worker");
  const recovery = {
    version: 1,
    predecessor: {
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      environmentId: "lost-worker",
      ownerEpoch: active.activeOwnerEpoch,
    },
  };
  const held = await store.prepareSessionPlacement(session.sessionId);
  try {
    expect(held.current()).not.toHaveProperty("confirmedLossRecovery");
    await providerService({ inspect: async () => ({ status: "destroyed" }) }).reconcileEnvironment(
      active.environmentId,
    );
    // No placement read after confirmation: the environment writer's receipt must publish it.
    expect(held.current()?.confirmedLossRecovery).toEqual(recovery);
  } finally {
    held.release();
  }
  await failOwned(store, active);
  await support.reopenWorkerEnvironmentStore();
  store = placements();
  const failed = await store.getAsync(session.sessionId);
  assert(failed?.state === "failed");
  expect(failed.confirmedLossRecovery).toEqual(recovery);
  await expect(
    store.startDispatch({
      ...session,
      expectedPlacement: { ...failed, activeOwnerEpoch: active.activeOwnerEpoch + 1 },
    }),
  ).rejects.toThrow("changed before redispatch");
  let requested = await store.startDispatch({ ...session, expectedPlacement: failed });
  const spare = await store.transition({
    sessionId: session.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: requested.generation,
    patch: { environmentId: "unactivated-spare" },
  });
  await store.fail({
    sessionId: session.sessionId,
    expectedGeneration: spare.generation,
    recoveryError: "Spare setup failed before native execution",
  });
  // Prepared-worker fallback deliberately has no expectedPlacement.
  requested = await store.startDispatch(session);
  const replacement = await activate(store, requested, "replacement-worker");
  const sandbox = await createRemoteExecPlacementSandbox({
    placement: replacement,
    environments: support.testState.store,
    workspaceDir: "/local/workspace",
  });
  expect(sandbox.nativeWorkerPlacement?.recovery).toEqual(recovery);
  expect(sandbox.nativeWorkerPlacement?.owner.environmentId).toBe("replacement-worker");

  await providerService({ inspect: async () => ({ status: "destroyed" }) }).reconcileEnvironment(
    replacement.environmentId,
  );
  const secondFailure = await failOwned(store, replacement);
  expect(secondFailure.confirmedLossRecovery?.predecessor.environmentId).toBe("replacement-worker");
  const local = await store.transition({
    sessionId: session.sessionId,
    from: "failed",
    to: "local",
    expectedGeneration: secondFailure.generation,
  });
  expect(local).not.toHaveProperty("confirmedLossRecovery");
  expect(await store.startDispatch(session)).not.toHaveProperty("confirmedLossRecovery");
});

it.each([
  "unknown",
  "dormant",
  "inspection-error",
  "requested-teardown",
  "generic-failure",
] as const)("does not mint native recovery from %s", async (scenario) => {
  const store = placements();
  const active = await activate(store, await store.startDispatch(session), "not-confirmed");
  if (scenario === "requested-teardown" || scenario === "generic-failure") {
    await support.testState.store.requestDestroy({
      environmentId: active.environmentId,
      state: "attached",
      ...(scenario === "generic-failure"
        ? { terminalState: "failed" as const, lastError: "Synthetic bootstrap failure" }
        : {}),
    });
  }
  await providerService({
    inspect: async () => {
      if (scenario === "inspection-error") {
        throw new Error("Inspection connectivity unavailable");
      }
      return {
        status: scenario === "unknown" || scenario === "dormant" ? scenario : "destroyed",
      };
    },
  }).reconcileEnvironment(active.environmentId);
  expect(await store.getAsync(session.sessionId)).not.toHaveProperty("confirmedLossRecovery");
});

it.each(["epoch", "lease"] as const)(
  "refuses a stale %s observation without changing the placement or accepting teardown",
  async (mismatch) => {
    const store = placements();
    const active = await activate(store, await store.startDispatch(session), "changed-owner");
    const environment = support.testState.store.get(active.environmentId)!;
    assert(environment.leaseId);
    await expect(
      support.testState.store.requestDestroy({
        environmentId: environment.environmentId,
        state: "attached",
        terminalState: "failed",
        confirmedLoss: {
          status: "destroyed",
          ownerEpoch: environment.ownerEpoch + Number(mismatch === "epoch"),
          leaseId: mismatch === "lease" ? "different-lease" : environment.leaseId,
        },
      }),
    ).rejects.toThrow("changed before loss confirmation");
    expect(await store.getAsync(session.sessionId)).toEqual(active);
    expect(support.testState.store.get(active.environmentId)?.destroyRequestedAtMs).toBeNull();
  },
);
