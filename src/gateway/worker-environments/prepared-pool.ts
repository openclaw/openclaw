import { readWorkerProjectPreparation } from "./preparation-identity.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import * as pool from "./prepared-pool-admission.js";
import { runPreparedPoolPass } from "./prepared-pool-pass.js";
import {
  createPreparedPoolPresence,
  matchingPreparedPoolPresenceDemand,
} from "./prepared-pool-presence.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerEnvironmentRecord as Environment } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";
/** Environment rows own inventory; placement activation and explicit builds establish demand. */
export function createPreparedWorkerPool(options: pool.PoolOptions) {
  const { store, signal, now } = options;
  let inFlight: Promise<void> | undefined;
  let requested = false;
  let presenceInFlight: Promise<void> | undefined;
  let presenceAdmitted = false;
  const preparations = new Map<string, AbortController>();
  const presence = createPreparedPoolPresence({ ...options, schedule: () => schedule() });
  const runPass = () =>
    runPreparedPoolPass(options, presence, preparations, () => presenceAdmitted);
  const scheduleInventory = () => {
    if (signal.aborted) {
      return Promise.resolve();
    }
    requested = true;
    return (inFlight ??= (async () => {
      try {
        while (requested && !signal.aborted) {
          requested = false;
          await runPass();
        }
      } finally {
        inFlight = undefined;
      }
    })());
  };
  const schedule = async () => {
    if (signal.aborted) {
      return;
    }
    await store.ready();
    await presence.ready();
    signal.throwIfAborted();
    // Repository admission has one owner and one in-flight operation, but cannot
    // hold inventory cleanup or independently authorized project refill hostage.
    const admission = (presenceInFlight ??= (async () => {
      presenceAdmitted = false;
      const previousDemand = presence.current();
      try {
        await presence.maintain();
        presenceAdmitted = true;
      } finally {
        presenceInFlight = undefined;
        if (previousDemand || presence.current()) {
          await scheduleInventory();
        }
      }
    })());
    const results = await Promise.allSettled([admission, scheduleInventory()]);
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  };
  const noteDemand = async (environmentId: string) => {
    signal.throwIfAborted();
    const record = store.get(environmentId);
    const preparation = record && readWorkerProjectPreparation(record.profileSnapshot.project);
    if (record?.state !== "attached" || !record.leaseId || !preparation) {
      return;
    }
    const demandAtMs = record.lastActivatedAtMs;
    if (demandAtMs === null) {
      return;
    }
    const provider = options.resolveProvider(record.providerId);
    await provider?.notePreparedDemand?.(
      { leaseId: record.leaseId, profile: pool.snapshotSettings(record) },
      { preparationKey: preparation.key, demandAtMs },
    );
  };
  const candidates = (intent: WorkerProviderPreparedIntent) =>
    intent.preparationKey
      ? store.list().filter((record) => {
          const limits = pool.poolPolicy(options, record.profileId, record.providerId);
          const presenceDemand = presence.current();
          return (
            limits.target > 0 &&
            limits.maxTotal > 0 &&
            record.state === "ready" &&
            record.providerId === intent.providerId &&
            record.preparation !== null &&
            record.preparation.key === intent.preparationKey &&
            record.preparation.consumedAtMs === null &&
            ((presenceDemand?.project.key ===
              readWorkerProjectSnapshot(record.profileSnapshot.project)?.key &&
              (presenceDemand!.retireAtMs ?? Number.MAX_SAFE_INTEGER) > now()) ||
              record.preparation.expiresAtMs > now()) &&
            record.destroyRequestedAtMs === null &&
            record.sharedHost === false &&
            record.nodeDeviceId !== null &&
            record.leaseId !== null
          );
        })
      : [];
  const maintain = async (environmentId?: string) => {
    if (signal.aborted) {
      return;
    }
    if (environmentId) {
      await noteDemand(environmentId).catch(() => {
        if (!signal.aborted) {
          options.warn("Prepared snapshot demand could not be recorded");
        }
      });
    }
    await schedule().catch((error: unknown) => {
      if (!signal.aborted) {
        options.warn(`Prepared worker maintenance will retry: ${boundedWorkerError(error)}`);
      }
    });
  };
  const canPruneDemand = (record: Environment, nowMs: number): boolean => {
    const demandAtMs = pool.demandAt(record);
    if (demandAtMs === undefined || !readWorkerProjectPreparation(record.profileSnapshot.project)) {
      return true;
    }
    const presenceDemand = matchingPreparedPoolPresenceDemand(record, presence.current());
    if (presenceDemand) {
      return presenceDemand.retireAtMs !== null && presenceDemand.retireAtMs <= nowMs;
    }
    // Unavailable policy cannot prove expiry. Retain metadata only; physical
    // cleanup is independent and must not wait for a provider to return.
    try {
      const timeout = options
        .resolveProvider(record.providerId)
        ?.resolvePreparedIdleTimeoutMs?.(pool.snapshotSettings(record));
      return (
        timeout !== undefined &&
        Number.isSafeInteger(timeout) &&
        timeout > 0 &&
        demandAtMs + timeout <= nowMs
      );
    } catch {
      return false;
    }
  };
  const cancelPreparation = async (environmentId: string) => {
    await store.ready();
    const record = store.get(environmentId);
    const controller = preparations.get(environmentId);
    if (record?.preparation && (await pool.retirePoolRecord(options, record, "invalidated"))) {
      // The durable cancellation fences readiness; the lifecycle retains provider
      // custody until its aborted operation and physical cleanup actually settle.
      controller?.abort();
    }
  };
  return {
    schedule,
    noteDemand,
    candidates,
    maintain,
    canPruneDemand,
    cancelPreparation,
    summary: () => ({
      maxTotal: options.getConfig().cloudWorkers?.preparedPool?.maxTotal ?? pool.DEFAULT_MAX_TOTAL,
      reservedEnvironmentIds: store.preparedReservationEnvironmentIds(),
    }),
    target: (profileId: string) => pool.poolPolicy(options, profileId).target,
    setHumanPresence: presence.set,
  };
}
