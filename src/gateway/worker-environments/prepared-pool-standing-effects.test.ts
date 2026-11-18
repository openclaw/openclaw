import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import {
  createStandingService,
  installStandingPolicy,
} from "./prepared-pool-standing.test-support.js";
import {
  createPreparationArtifacts,
  PREPARATION_TARGET,
  usePreparedPoolFixture,
} from "./prepared-pool.test-support.js";

const f = usePreparedPoolFixture();
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

function lifecycle(beforeAllocate?: () => Promise<void>, beforeArtifacts?: () => Promise<void>) {
  const artifacts = createPreparationArtifacts();
  const allocate = vi.fn(
    async (
      operationId: string,
      options: NonNullable<Parameters<WorkerProvider["provision"]>[2]>,
    ) => {
      const enrollment = await options.beginNodeEnrollment!();
      if (enrollment.mode !== "connect") {
        throw new Error("Expected a fresh node enrollment");
      }
      const deviceId = "node:" + operationId;
      await completeWorkerNodeSetupForTest({
        baseDir: f.root,
        store: f.store,
        setupId: enrollment.setupId,
        deviceId,
        completedAtMs: f.nowMs,
      });
      return { leaseId: "lease:" + operationId, node: { deviceId }, sharedHost: false };
    },
  );
  const destroy = vi.fn<WorkerProvider["destroy"]>(async () => {});
  f.provider = {
    ...f.provider,
    requiresNodeEnrollment: true,
    supportedExecutionModes: ["worker-turn"],
    supportsProjectPreparation: () => true,
    resolvePreparationTarget: () => PREPARATION_TARGET,
    resolveAllocation: async (_profile, operationId) => ({
      leaseId: "lease:" + operationId,
      sharedHost: false,
    }),
    prepareProvision: async (_profile, operationId, options) => {
      await beforeAllocate?.();
      return () => allocate(operationId, options!);
    },
    destroy,
  };
  const warn = vi.fn();
  const service = () => {
    f.service = createStandingService(f, {
      logger: { warn },
      prepareNodeArtifacts: async () => {
        await beforeArtifacts?.();
        return { artifacts, assertCurrent: () => {} };
      },
    });
    return f.service;
  };
  return { service, allocate, destroy, warn };
}

it.each(["disabled", "load-error", "disposed"] as const)(
  "cleans up finite and pending reserves under %s integration policy, then recovers",
  async (failure) => {
    const policy = installStandingPolicy(f.config);
    f.developmentProfile.readyWorkers = 3;
    const effects = lifecycle();
    const service = effects.service();
    const intent = await service.prepareProjectIntent("development", {
      imageReserve: true,
      executionMode: "worker-turn",
    });
    const expiresAtMs = f.nowMs + 500;
    for (let i = 0; i < 3; i++) {
      await f.store.createIntent({
        environmentId: "finite-" + i,
        provisionOperationId: "finite-op-" + i,
        providerId: intent.providerId,
        profileId: "development",
        profileSnapshot: intent.profileSnapshot,
        preparation: {
          purpose: "reserve",
          key: intent.profileSnapshot.runtimePreparation!.key,
          demandAtMs: f.nowMs,
          expiresAtMs,
        },
      });
    }
    await service.setHumanPresence(false);
    expect(effects.allocate).toHaveBeenCalledTimes(3);
    expect(f.reserves().every((record) => record.state === "ready")).toBe(true);
    expect(effects.allocate.mock.calls.every(([, options]) => options.project === undefined)).toBe(
      true,
    );
    const attached = await f.attach(f.store.get("finite-0")!);
    const pending = f.store.get("finite-1")!;
    await f.store.requestPreparedDestroy({
      environmentId: pending.environmentId,
      ownerEpoch: pending.ownerEpoch,
      preparationKey: pending.preparation!.key,
      reason: "invalidated",
      assertCurrent: () => {},
    });
    if (failure === "disposed") {
      await policy.instance.dispose();
    } else if (failure === "disabled") {
      policy.record.enabled = false;
    } else {
      policy.record.status = "error";
    }
    f.developmentProfile.readyWorkers = 0;
    f.nowMs = expiresAtMs + 1;
    await expect(service.setHumanPresence(false)).rejects.toThrow();
    expect(f.store.get("finite-1")?.state).toBe("destroyed");
    expect(f.store.get("finite-2")?.state).toBe("destroyed");
    expect(effects.destroy).toHaveBeenCalledTimes(2);
    expect(f.store.get(attached.environmentId)?.state).toBe("attached");
    expect(f.store.get("finite-2")?.preparation?.expiresAtMs).toBe(expiresAtMs);
    expect(effects.allocate).toHaveBeenCalledTimes(3);
    expect(policy.credentials).not.toHaveBeenCalled();
    const recovered = installStandingPolicy(f.config);
    f.developmentProfile.readyWorkers = 1;
    await service.setHumanPresence(false);
    expect(effects.allocate).toHaveBeenCalledTimes(4);
    expect(f.reserves().filter((record) => record.state === "ready")).toHaveLength(1);
    expect(recovered.credentials).not.toHaveBeenCalled();
  },
);

it.each([
  { change: "integration-disabled", recovered: false },
  { change: "integration-replaced", recovered: false },
  { change: "profile-changed", recovered: false },
  { change: "profile-removed", recovered: false },
  { change: "target-disabled", recovered: false },
  { change: "integration-replaced", recovered: true },
  { change: "target-disabled", recovered: true },
  { change: "profile-changed", recovered: true },
  { change: "profile-removed", recovered: true },
])(
  "rejects $change before allocation I/O (recovered=$recovered)",
  async ({ change, recovered }) => {
    const policy = installStandingPolicy(f.config);
    const gate = f.gate();
    const effects = lifecycle(async () => {
      gate.entered.resolve();
      await gate.release.promise;
    });
    let service = effects.service();
    if (recovered) {
      const intent = await service.prepareProjectIntent("development", {
        imageReserve: true,
        executionMode: "worker-turn",
      });
      await f.store.createIntent({
        environmentId: "recovered-request",
        provisionOperationId: "recovered-operation",
        providerId: intent.providerId,
        profileId: "development",
        profileSnapshot: intent.profileSnapshot,
        preparation: {
          purpose: "reserve",
          key: intent.profileSnapshot.runtimePreparation!.key,
          demandAtMs: f.nowMs,
          expiresAtMs: f.nowMs + 500,
        },
      });
      await service.stop();
      await f.reopenStore();
      service = effects.service();
    }
    const running = service.setHumanPresence(false);
    f.operations.add(running);
    await awaitGateBeforeSettlement(
      gate.entered.promise,
      running,
      "Standing policy never reached provider preparation",
    );
    if (change === "integration-disabled") {
      policy.record.enabled = false;
    } else if (change === "integration-replaced") {
      installStandingPolicy(f.config);
    } else if (change === "profile-removed") {
      delete f.config.cloudWorkers!.profiles!.development;
    } else if (change === "target-disabled") {
      f.developmentProfile.readyWorkers = 0;
    } else {
      f.developmentProfile.settings = { region: "changed" };
    }
    gate.release.resolve();
    await running;
    expect(effects.allocate).not.toHaveBeenCalled();
    expect(f.reserves().some((record) => record.state === "ready")).toBe(false);
    expect(policy.credentials).not.toHaveBeenCalled();
  },
);

it("keeps stable v1 project rows, active ownership, settings, and finite deadlines on reopen", async () => {
  // v2026.10.9 (8b18b5578f66) writes this v1 project identity and the same reserve tuple.
  const expiresAtMs = f.nowMs + 10;
  const legacyProfile = {
    settings: {},
    executionMode: "worker-turn",
    project: {
      key: "a".repeat(64),
      root: path.join(f.root, "stable-project"),
      baseCommit: "d".repeat(40),
      preparation: {
        key: "b".repeat(64),
        cacheKey: "9".repeat(64),
        contractVersion: 1,
        target: { machineClass: "standard", platform: "linux", arch: "x64" },
        artifacts: {
          nodeBootstrapSha256: "e".repeat(64),
          enabledPluginIds: [],
          workerBundleHash: "c".repeat(64),
          workerArchiveSha256: "f".repeat(64),
          openclawVersion: "2026.8.1",
          protocolFeatures: [],
        },
      },
    },
  } satisfies WorkerProviderPreparedIntent["profileSnapshot"];
  const createLegacy = (environmentId: string, reserve: boolean) =>
    f.store.createIntent({
      environmentId,
      providerId: f.provider.id,
      profileId: "development",
      provisionOperationId: "operation:" + environmentId,
      profileSnapshot: legacyProfile,
      ...(reserve
        ? {
            preparation: {
              purpose: "reserve",
              key: legacyProfile.project.preparation.key,
              demandAtMs: f.nowMs,
              expiresAtMs,
            },
          }
        : {}),
    });
  const spare = await f.ready(await createLegacy("stable-finite", true));
  const attached = await f.attach(await f.ready(await createLegacy("stable-active", false)));
  const legacyIntent = { providerId: f.provider.id, profileSnapshot: legacyProfile };
  const settings = structuredClone(f.config);
  await f.reopenStore();
  expect(f.store.get(spare.environmentId)).toEqual(spare);
  expect(f.store.get(attached.environmentId)).toEqual(attached);
  const effects = lifecycle();
  const service = effects.service();
  expect(service.getPreparedCandidates(legacyIntent).map((record) => record.environmentId)).toEqual(
    [spare.environmentId],
  );
  f.nowMs = expiresAtMs + 1;
  expect(service.getPreparedCandidates(legacyIntent)).toEqual([]);
  await service.setHumanPresence(false);
  expect(f.store.get(spare.environmentId)).toMatchObject({
    state: "destroyed",
    profileSnapshot: spare.profileSnapshot,
    preparation: { expiresAtMs },
  });
  expect(f.store.get(attached.environmentId)).toEqual(attached);
  expect(f.config).toEqual(settings);
  expect(effects.allocate).not.toHaveBeenCalled();
  expect(effects.destroy).toHaveBeenCalledOnce();
});

it("preserves standing IDs during restart reconstruction while expiry and requested cleanup run", async () => {
  installStandingPolicy(f.config);
  f.developmentProfile.readyWorkers = 2;
  const preparation = f.gate();
  const cleanup = f.gate();
  let restarting = false;
  const effects = lifecycle(undefined, async () => {
    if (restarting) {
      preparation.entered.resolve();
      await preparation.release.promise;
    }
  });
  let service = effects.service();
  await service.setHumanPresence(false);
  const originalIds = f
    .reserves()
    .map((record) => record.environmentId)
    .toSorted();
  expect(originalIds).toHaveLength(2);
  const intent = await service.prepareProjectIntent("development", {
    imageReserve: true,
    executionMode: "worker-turn",
  });
  for (const [environmentId, expiresAtMs] of [
    ["expired", f.nowMs + 1],
    ["cancelled", f.nowMs + 10_000],
  ] as const) {
    await f.ready(
      await f.store.createIntent({
        environmentId,
        provisionOperationId: "operation:" + environmentId,
        providerId: intent.providerId,
        profileId: "development",
        profileSnapshot: intent.profileSnapshot,
        preparation: {
          purpose: "reserve",
          key: intent.profileSnapshot.runtimePreparation!.key,
          demandAtMs: f.nowMs,
          expiresAtMs,
        },
      }),
    );
  }
  const cancelled = f.store.get("cancelled")!;
  await f.store.requestPreparedDestroy({
    environmentId: cancelled.environmentId,
    ownerEpoch: cancelled.ownerEpoch,
    preparationKey: cancelled.preparation!.key,
    reason: "invalidated",
    assertCurrent: () => {},
  });
  effects.destroy.mockImplementation(async (lease) => {
    if (lease.leaseId === "lease:expired") {
      cleanup.entered.resolve();
    }
  });
  await service.stop();
  await f.reopenStore();
  f.nowMs += 2;
  restarting = true;
  service = effects.service();
  const running = service.setHumanPresence(false);
  f.operations.add(running);
  await awaitGateBeforeSettlement(
    preparation.entered.promise,
    running,
    "No reconstruction preparation",
  );
  await awaitGateBeforeSettlement(
    cleanup.entered.promise,
    running,
    "Expiry must not wait for reconstruction",
  );
  preparation.release.resolve();
  await running;
  expect(
    f
      .reserves()
      .filter((record) => record.state === "ready")
      .map((record) => record.environmentId)
      .toSorted(),
  ).toEqual(originalIds);
  expect(effects.allocate).toHaveBeenCalledTimes(2);
  expect(effects.destroy.mock.calls.map(([lease]) => lease.leaseId).toSorted()).toEqual([
    "lease:cancelled",
    "lease:expired",
  ]);
});
