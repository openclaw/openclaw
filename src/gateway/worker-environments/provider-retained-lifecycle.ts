import { randomUUID } from "node:crypto";
import type { WorkerProvider } from "../../plugins/types.js";
import { assertWorkerResourceReceiptMatch } from "../../plugins/worker-resource-receipt.js";
import { requireWorkerRetentionObservation } from "../../plugins/worker-retention.js";
import type { WorkerRetentionOperation } from "../../plugins/worker-retention.types.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerRuntimeRefresher } from "./provider-runtime-refresh.js";
import { requireWorkerLeaseStatus, requireWorkerProfile } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export type WorkerRetainedRequest = {
  environmentId: string;
  expectedOwnerEpoch: number;
  assertCurrent: () => void;
  signal?: AbortSignal;
};

/** Existing provider queue and environment writer own retained effects and their recovery. */
export function createWorkerRetainedLifecycle(
  options: WorkerProviderLifecycleOptions & {
    ownerSignal: AbortSignal;
    providerFor: (id: string) => WorkerProvider;
    requireCurrentOwner: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord;
    refreshRuntime: ReturnType<typeof createWorkerRuntimeRefresher>["refresh"];
  },
) {
  const now = options.now ?? Date.now;
  const current = (
    record: WorkerEnvironmentRecord,
    assertCurrent: () => void,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    assertCurrent();
    const live = options.requireCurrentOwner(record);
    const provisioning = live.state === "provisioning" && live.leaseId === null;
    if (
      options.isStopping() ||
      live.destroyRequestedAtMs !== null ||
      !live.retention ||
      !live.resourceReceipt ||
      (!provisioning &&
        (!["ready", "idle", "attached"].includes(live.state) ||
          !live.leaseId ||
          !live.nodeDeviceId ||
          live.sharedHost !== false))
    ) {
      throw new Error("Retained lifecycle lost its dedicated node environment owner");
    }
    return live;
  };
  const leaseFor = (record: WorkerEnvironmentRecord) => ({
    leaseId: record.leaseId ?? record.resourceReceipt!.leaseId,
    profile: requireWorkerProfile(record.profileSnapshot.settings),
    resourceReceipt: record.resourceReceipt!,
    retention: record.retention!.policy,
  });
  const observe = async (
    record: WorkerEnvironmentRecord,
    assertCurrent: () => void,
    signal: AbortSignal,
  ) => {
    const live = current(record, assertCurrent, signal);
    const provider = options.providerFor(live.providerId);
    if (!provider.supportsResourceReceipts || !provider.setRetainedState) {
      throw new Error("Worker provider cannot honor retained resource custody");
    }
    const inspectionSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const observed = requireWorkerLeaseStatus(
      await options.callProvider(
        live.environmentId,
        "inspect-retained",
        () => {
          current(live, assertCurrent, inspectionSignal);
          return provider.inspect({ ...leaseFor(live), signal: inspectionSignal });
        },
        undefined,
        inspectionSignal,
      ),
    );
    current(live, assertCurrent, signal);
    assertWorkerResourceReceiptMatch(live.resourceReceipt!, observed.resourceReceipt);
    if (!observed.retention) {
      throw new Error("Provider did not report the retained work window; custody preserved");
    }
    return options.store.recordRetentionObservation({
      environmentId: live.environmentId,
      expectedOwnerEpoch: live.ownerEpoch,
      observation: observed.retention,
      assertCurrent: () => {
        current(live, assertCurrent, signal);
      },
    });
  };
  const mutate = async (
    record: WorkerEnvironmentRecord,
    action: WorkerRetentionOperation["action"],
    assertCurrent: () => void,
    signal: AbortSignal,
  ) => {
    let live = current(record, assertCurrent, signal);
    const retention = live.retention!;
    let operation = retention.operation;
    if (!operation) {
      const observation = retention.observation;
      if (
        !observation ||
        observation.state === "unavailable" ||
        observation.state === "transitioning"
      ) {
        throw new Error("Retained resource observation is unavailable; inspect before retrying");
      }
      operation = { id: randomUUID(), action, expectedClaimRevision: observation.claimRevision };
      live = await options.store.beginRetentionOperation({
        environmentId: live.environmentId,
        expectedOwnerEpoch: live.ownerEpoch,
        operation,
        assertCurrent: () => {
          current(record, assertCurrent, signal);
        },
      });
    } else if (operation.action !== action) {
      throw new Error("An earlier retained lifecycle operation must settle before a new action");
    }
    const pending = operation;
    const provider = options.providerFor(live.providerId);
    if (!provider.setRetainedState || !provider.supportsResourceReceipts) {
      throw new Error("Worker provider cannot replay retained lifecycle operations");
    }
    if (action === "pause") {
      // Join native command settlement before asking the provider to suspend compute.
      await options.tunnelManager?.stop(live.environmentId, live.ownerEpoch);
      current(live, assertCurrent, signal);
    }
    const mutationSignal = AbortSignal.any([signal, AbortSignal.timeout(240_000)]);
    const observation = await options.callProvider(
      live.environmentId,
      action,
      async () => {
        const assertEffect = () => {
          const owner = current(live, assertCurrent, mutationSignal);
          if (owner.retention?.operation?.id !== pending.id) {
            throw new Error("Retained lifecycle operation owner changed");
          }
        };
        assertEffect();
        return provider.setRetainedState!({
          ...leaseFor(live),
          operation: pending,
          signal: mutationSignal,
          assertCurrent: assertEffect,
        });
      },
      240_000,
    );
    current(live, assertCurrent, signal);
    return options.store.recordRetentionObservation({
      environmentId: live.environmentId,
      expectedOwnerEpoch: live.ownerEpoch,
      observation: requireWorkerRetentionObservation(observation),
      assertCurrent: () => {
        current(live, assertCurrent, signal);
      },
    });
  };
  const reconcile = async (record: WorkerEnvironmentRecord, signal: AbortSignal) => {
    let live = await observe(record, () => {}, signal);
    // Persisted resume intent retains custody, not caller authority to start compute.
    if (live.retention!.operation?.action === "pause") {
      live = await mutate(live, "pause", () => {}, signal);
    }
    const observation = live.retention!.observation;
    // Maintenance may close an expired work window, never authorize another one.
    if (
      !live.retention!.operation &&
      observation &&
      (observation.state === "expired" ||
        (observation.state === "running" && observation.computeExpiresAtMs <= now()))
    ) {
      live = await mutate(live, "pause", () => {}, signal);
    }
    return live;
  };
  const requireRunning = (
    record: WorkerEnvironmentRecord,
    assertCurrent: () => void,
    signal: AbortSignal,
  ) => {
    const owner = current(record, assertCurrent, signal);
    const retained = owner.retention!;
    if (
      retained.operation ||
      retained.observation?.state !== "running" ||
      retained.observation.computeExpiresAtMs <= now()
    ) {
      throw new Error("Retained work window is not active; explicit wake required");
    }
    return owner;
  };
  const resumeCompute = async (
    record: WorkerEnvironmentRecord,
    assertCurrent: () => void,
    signal: AbortSignal,
  ) => {
    let live = record;
    if (live.retention!.operation) {
      live = await mutate(live, live.retention!.operation.action, assertCurrent, signal);
    }
    const observed = live.retention!.observation!;
    if (observed.state !== "running" || observed.computeExpiresAtMs <= now()) {
      // Provider idle suspension closes compute only after an explicit observed pause.
      live = await mutate(live, "pause", assertCurrent, signal);
      live = await mutate(live, "resume", assertCurrent, signal);
    }
    return requireRunning(live, assertCurrent, signal);
  };
  const setRuntimeAdmission = (
    record: WorkerEnvironmentRecord,
    assertCurrent: () => void,
    signal: AbortSignal,
    ready: boolean,
  ) => {
    const live = current(record, assertCurrent, signal);
    const observation = live.retention!.observation;
    if (!observation) {
      throw new Error("Retained resource has no work-window observation");
    }
    return options.store.setRetentionRuntimeAdmission({
      ready,
      environmentId: live.environmentId,
      expectedOwnerEpoch: live.ownerEpoch,
      expectedClaimRevision: observation.claimRevision,
      assertCurrent: () => {
        current(live, assertCurrent, signal);
      },
    });
  };
  const run = (request: WorkerRetainedRequest, action: WorkerRetentionOperation["action"]) =>
    options.withLock(request.environmentId, async () => {
      const signal = AbortSignal.any([
        options.ownerSignal,
        ...(request.signal ? [request.signal] : []),
      ]);
      await options.store.ready();
      request.assertCurrent();
      const record = options.store.get(request.environmentId);
      if (!record || record.ownerEpoch !== request.expectedOwnerEpoch) {
        throw new Error("Retained lifecycle environment owner changed");
      }
      if (!record.retention) {
        if (action === "pause") {
          throw new Error("Worker does not own a retained disk");
        }
        return;
      }
      if (record.state === "provisioning") {
        throw new Error("Retry the original creation request to recover retained provisioning");
      }
      try {
        let live = await observe(record, request.assertCurrent, signal);
        if (action === "pause") {
          if (live.retention!.operation) {
            live = await mutate(live, "pause", request.assertCurrent, signal);
          }
          if (
            !live.retention!.operation &&
            live.retention!.observation?.state === "suspended" &&
            live.retention!.observation.operation?.action === "pause" &&
            live.retention!.observation.operation.phase === "observed"
          ) {
            return;
          }
          live = await mutate(live, "pause", request.assertCurrent, signal);
          if (live.retention!.operation || live.retention!.observation?.state !== "suspended") {
            throw new Error("Retained suspension remains unconfirmed");
          }
          return;
        }
        const resumed = await resumeCompute(live, request.assertCurrent, signal);
        const assertRunning = () => {
          requireRunning(resumed, request.assertCurrent, signal);
        };
        assertRunning();
        if (!options.waitForRetainedNode || !options.ensureNodeWorkerBundle) {
          throw new Error("Retained node reconnect admission is unavailable");
        }
        // Restart must not mistake a partial runtime refresh for usable readiness.
        await setRuntimeAdmission(resumed, request.assertCurrent, signal, false);
        const reconnectSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        await options.waitForRetainedNode(resumed.nodeDeviceId!, {
          signal: reconnectSignal,
          assertCurrent: assertRunning,
        });
        assertRunning();
        const artifact = await options.prepareInstallation("bundle", signal);
        assertRunning();
        if (artifact.install !== "bundle") {
          throw new Error("Retained worker bundle is unavailable");
        }
        await options.refreshRuntime(
          resumed,
          options.providerFor(resumed.providerId),
          artifact,
          signal,
          assertRunning,
        );
        assertRunning();
        const installed = await options.ensureNodeWorkerBundle({
          deviceId: resumed.nodeDeviceId!,
          artifact,
          reason: "refresh",
          environmentId: resumed.environmentId,
          prewarm: true,
          signal,
          assertCurrent: assertRunning,
        });
        assertRunning();
        if (!sameWorkerBuild(installed, artifact)) {
          throw new Error("Retained worker runtime admission did not match the current build");
        }
        await setRuntimeAdmission(resumed, request.assertCurrent, signal, true);
      } catch (error) {
        await options.saveError(record, error);
        throw error;
      }
    });
  return {
    reconcile,
    // Only a fresh creation retry supplies this authority; maintenance never calls it.
    resumeProvision: async (
      record: WorkerEnvironmentRecord,
      assertCurrent: () => void,
      signal: AbortSignal,
    ) => resumeCompute(await observe(record, assertCurrent, signal), assertCurrent, signal),
    admitProvision: async (record: WorkerEnvironmentRecord, signal: AbortSignal) =>
      setRuntimeAdmission(await reconcile(record, signal), () => {}, signal, true),
    ensureRetainedRunning: (request: WorkerRetainedRequest) => run(request, "resume"),
    suspendRetained: (request: WorkerRetainedRequest) => run(request, "pause"),
  };
}
