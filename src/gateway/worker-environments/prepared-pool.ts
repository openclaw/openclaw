import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { createWorkerProviderIntent } from "./provider-intent.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";

const DEFAULT_READY_WORKERS = 1;
const DEFAULT_MAX_TOTAL = 4;
const PREPARATION_CONCURRENCY = 2;

type PoolOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareIntent: (
    profileId: string,
    options: NonNullable<
      Parameters<ReturnType<typeof createWorkerProviderIntent>["prepareIntent"]>[1]
    >,
  ) => Promise<WorkerProviderPreparedIntent>;
  assertIntentCurrent: (profileId: string, intent: WorkerProviderPreparedIntent) => void;
  prepareRetention: (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
  ) => Promise<{ isCurrent: () => boolean } | undefined>;
  reconcile: (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
    beforeReconcile: () => void,
  ) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
  warn: (message: string) => void;
};

/** Environment rows own inventory; placement activation and explicit builds establish demand. */
export function createPreparedWorkerPool(options: PoolOptions) {
  const { store, signal, now } = options;
  let inFlight: Promise<void> | undefined;
  let requested = false;
  const preparations = new Map<string, AbortController>();
  const current = () => signal.throwIfAborted();
  const configuredPolicy = (profileId: string) => {
    const config = options.getConfig().cloudWorkers;
    const profile = config?.profiles?.[profileId];
    return {
      providerId: profile ? normalizeCapabilityProviderId(profile.provider) : undefined,
      target: profile ? (profile.readyWorkers ?? DEFAULT_READY_WORKERS) : 0,
      maxTotal: config?.preparedPool?.maxTotal ?? DEFAULT_MAX_TOTAL,
    };
  };
  const policy = (record: Pick<WorkerEnvironmentRecord, "profileId" | "providerId">) => {
    const config = configuredPolicy(record.profileId);
    const configured = config.providerId === record.providerId;
    return {
      configured,
      target: configured ? config.target : 0,
      maxTotal: config.maxTotal,
    };
  };
  const groupKey = (record: WorkerEnvironmentRecord) => {
    const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
    return project ? JSON.stringify([record.providerId, record.profileId, project.key]) : undefined;
  };
  // Failed claims inherit only the original preparation window; success records
  // a separate fact that survives teardown and placement retirement.
  const demandAt = (record: WorkerEnvironmentRecord) =>
    record.lastActivatedAtMs ?? record.preparation?.demandAtMs;
  const retire = (record: WorkerEnvironmentRecord, reason: "expired" | "invalidated") => {
    if (!record.preparation) {
      return undefined;
    }
    return store.requestPreparedDestroy({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      preparationKey: record.preparation.key,
      reason,
      assertCurrent: current,
    });
  };
  const snapshotSettings = (record: WorkerEnvironmentRecord): WorkerProfile => {
    const settings = record.profileSnapshot.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Prepared worker profile settings are unavailable");
    }
    return settings;
  };
  const runPass = async () => {
    await store.ready();
    current();
    const inventory = store.list();
    const sources = new Map<string, { record: WorkerEnvironmentRecord; demandAtMs: number }>();
    const buildingKeys = new Set<string>();
    for (const record of inventory) {
      const demandAtMs = demandAt(record);
      const key = groupKey(record);
      const build =
        record.preparation?.purpose === "build" &&
        record.preparation.consumedAtMs === null &&
        record.destroyRequestedAtMs === null &&
        record.state !== "failed" &&
        record.state !== "destroyed";
      if (key && build && record.state !== "ready") {
        buildingKeys.add(key);
      }
      if (
        key &&
        demandAtMs !== undefined &&
        readWorkerProjectPreparation(record.profileSnapshot.project)
      ) {
        const previous = sources.get(key);
        if (
          !previous ||
          demandAtMs > previous.demandAtMs ||
          (demandAtMs === previous.demandAtMs && build)
        ) {
          sources.set(key, { record, demandAtMs });
        }
      }
    }
    const eligible = new Map<
      string,
      {
        source: WorkerEnvironmentRecord;
        preparationKey: string;
        demandAtMs: number;
        expiresAtMs: number;
        retention?: { isCurrent: () => boolean };
        deferred?: boolean;
        intent?: WorkerProviderPreparedIntent;
        slots?: number;
      }
    >();
    const defer = (generation: NonNullable<ReturnType<typeof eligible.get>>, error: unknown) => {
      generation.deferred = true;
      options.warn(
        `Prepared worker maintenance deferred (${generation.source.profileId}); retaining unused capacity until its original expiry: ${boundedWorkerError(error)}`,
      );
    };
    for (const [key, { record, demandAtMs }] of sources) {
      const limits = policy(record);
      if (
        !limits.configured ||
        (limits.target === 0 && !buildingKeys.has(key)) ||
        limits.maxTotal === 0
      ) {
        continue;
      }
      const preparationKey = readWorkerProjectPreparation(record.profileSnapshot.project)!.key;
      try {
        const provider = options.resolveProvider(record.providerId);
        if (!provider) {
          throw new Error(`Worker provider is unavailable (${record.providerId})`);
        }
        const timeout = provider.resolvePreparedIdleTimeoutMs?.(snapshotSettings(record));
        if (
          Number.isSafeInteger(timeout) &&
          timeout &&
          timeout > 0 &&
          demandAtMs + timeout > now()
        ) {
          eligible.set(key, {
            source: record,
            preparationKey,
            demandAtMs,
            expiresAtMs: demandAtMs + timeout,
          });
        }
      } catch (error) {
        current();
        // Unknown provider policy cannot renew demand or invalidate an already owned lease.
        const expiresAtMs = inventory.reduce((latest, reserved) => {
          const preparation = reserved.preparation;
          return preparation?.consumedAtMs === null &&
            preparation.key === preparationKey &&
            groupKey(reserved) === key &&
            reserved.destroyRequestedAtMs === null &&
            !["failed", "destroyed"].includes(reserved.state)
            ? Math.max(latest, preparation.expiresAtMs)
            : latest;
        }, 0);
        const generation = { source: record, preparationKey, demandAtMs, expiresAtMs };
        defer(generation, error);
        if (expiresAtMs > now()) {
          eligible.set(key, generation);
        }
      }
    }
    const isGenerationCurrent = (generation: NonNullable<ReturnType<typeof eligible.get>>) => {
      current();
      if (
        !isDeepStrictEqual(
          store.get(generation.source.environmentId)?.profileSnapshot,
          generation.source.profileSnapshot,
        )
      ) {
        return false;
      }
      if (!generation.retention?.isCurrent()) {
        return false;
      }
      if (generation.intent) {
        options.assertIntentCurrent(generation.source.profileId, generation.intent);
      }
      return true;
    };
    const reconcile = async (record: WorkerEnvironmentRecord) => {
      current();
      let retirementReason: "expired" | "invalidated" | undefined;
      let retirement: ReturnType<typeof retire>;
      const beforeReconcile = () => {
        current();
        const owned = store.get(record.environmentId);
        if (
          !owned ||
          owned.preparation?.consumedAtMs !== null ||
          owned.destroyRequestedAtMs !== null
        ) {
          return;
        }
        const key = groupKey(owned);
        const generation = key ? eligible.get(key) : undefined;
        if (owned.preparation.expiresAtMs <= now()) {
          retirementReason = "expired";
        } else if (
          !generation ||
          generation.preparationKey !== owned.preparation.key ||
          !store.isPreparedIntentWithinCapacity({
            environmentId: owned.environmentId,
            ...policy(owned),
          })
        ) {
          retirementReason = "invalidated";
        } else if (generation.deferred) {
          throw new Error("Prepared worker maintenance is deferred");
        } else {
          try {
            if (!isGenerationCurrent(generation)) {
              retirementReason = "invalidated";
            }
          } catch (error) {
            current();
            defer(generation, error);
            throw error;
          }
        }
        if (retirementReason) {
          retirement ??= retire(owned, retirementReason);
          // Queue before lifecycle cleanup writes; the operation is joined on unwind below.
          void retirement?.catch(() => {});
          throw new Error("Prepared worker no longer satisfies its maintenance policy");
        }
      };
      try {
        beforeReconcile();
      } catch (error) {
        if (!retirementReason) {
          throw error;
        }
        await retirement;
        retirement = undefined;
        retirementReason = undefined;
      }
      const latest = store.get(record.environmentId);
      if (latest?.preparation?.consumedAtMs === null) {
        const controller = new AbortController();
        preparations.set(record.environmentId, controller);
        try {
          await options.reconcile(
            latest,
            AbortSignal.any([signal, controller.signal]),
            beforeReconcile,
          );
        } catch (error) {
          if (retirement) {
            const retiring = await retirement;
            if (retiring) {
              await options.reconcile(retiring, signal, current);
            }
          }
          throw error;
        } finally {
          preparations.delete(record.environmentId);
          await retirement;
        }
      }
    };
    const reconcileAll = (records: WorkerEnvironmentRecord[]) =>
      runTasksWithConcurrency({
        tasks: records.map((record) => () => reconcile(record)),
        limit: PREPARATION_CONCURRENCY,
        onTaskError: () => {
          if (!signal.aborted) {
            options.warn(
              "Prepared worker maintenance failed; inspect the recorded environment failure and cleanup state",
            );
          }
        },
      });
    const cleaned = new Set<string>();
    const retain = async (requireRetention: boolean) => {
      const kept = new Map<string, number>();
      let totalKept = 0;
      const cleanup: WorkerEnvironmentRecord[] = [];
      const work: WorkerEnvironmentRecord[] = [];
      // Builds admitted during an await belong to the next scheduled pass's
      // source snapshot. Existing rows still use live promotion and cleanup state.
      for (const snapshot of inventory.toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
        const record = store.get(snapshot.environmentId);
        if (
          !record ||
          record.preparation?.consumedAtMs !== null ||
          record.state === "destroyed" ||
          record.state === "failed"
        ) {
          continue;
        }
        current();
        const key = groupKey(record);
        const generation = key ? eligible.get(key) : undefined;
        const limits = policy(record);
        const count = key ? (kept.get(key) ?? 0) : 0;
        const expired = record.preparation.expiresAtMs <= now();
        const valid =
          !expired &&
          generation?.preparationKey === record.preparation.key &&
          (!requireRetention || generation.retention !== undefined || generation.deferred) &&
          ((record.preparation.purpose === "build" && record.state !== "ready") ||
            count < limits.target) &&
          totalKept < limits.maxTotal;
        if (record.destroyRequestedAtMs === null && !valid) {
          await retire(record, expired ? "expired" : "invalidated");
        } else if (record.destroyRequestedAtMs === null && key) {
          kept.set(key, count + 1);
          totalKept += 1;
        }
        const latest = store.get(record.environmentId)!;
        if (latest.destroyRequestedAtMs !== null) {
          if (!cleaned.has(record.environmentId)) {
            cleaned.add(record.environmentId);
            cleanup.push(latest);
          }
        } else if (!generation?.deferred) {
          work.push(latest);
        }
      }
      return { cleanup, work };
    };
    // Expiry and disabled/surplus capacity need no source or artifact admission.
    // Drain that cleanup first so unrelated GitHub latency cannot hold its owner.
    await reconcileAll((await retain(false)).cleanup);
    for (const [key, generation] of eligible) {
      try {
        generation.retention = await options.prepareRetention(generation.source, signal);
        current();
        if (!generation.retention) {
          eligible.delete(key);
        }
      } catch (error) {
        current();
        defer(generation, error);
      }
    }
    await reconcileAll((await retain(true)).cleanup);
    let plannedTotal = 0;
    for (const [key, generation] of eligible) {
      current();
      if (generation.deferred) {
        continue;
      }
      const { source } = generation;
      const limits = policy(source);
      const project = readWorkerProjectSnapshot(source.profileSnapshot.project)!;
      const slots = store.preparedCapacity({
        profileId: source.profileId,
        projectKey: project.key,
        ...limits,
        maxTotal: Math.max(0, limits.maxTotal - plannedTotal),
      });
      if (slots === 0 || generation.expiresAtMs <= now()) {
        continue;
      }
      try {
        const preparation = readWorkerProjectPreparation(source.profileSnapshot.project)!;
        const intent = await options.prepareIntent(source.profileId, {
          ...("source" in project
            ? { projectRepository: project }
            : { projectPath: project.root, projectCommit: project.baseCommit }),
          ...(typeof source.profileSnapshot.machineClass === "string"
            ? { machineClass: source.profileSnapshot.machineClass }
            : {}),
          ...(typeof source.profileSnapshot.os === "string"
            ? { os: source.profileSnapshot.os }
            : {}),
          ...(source.profileSnapshot.executionMode === "worker-turn" ||
          source.profileSnapshot.executionMode === "remote-exec"
            ? { executionMode: source.profileSnapshot.executionMode }
            : {}),
          setupAuthorized:
            preparation.setupRecipe !== undefined && preparation.runSetupScript !== false,
          runSetupScript: preparation.runSetupScript,
          signal,
        });
        current();
        if (intent.providerId !== source.providerId || intent.preparationKey !== preparation.key) {
          eligible.delete(key);
          continue;
        }
        generation.intent = intent;
        generation.slots = slots;
        plannedTotal += slots;
      } catch (error) {
        current();
        options.warn(
          `Prepared worker refill deferred (${source.profileId}): ${boundedWorkerError(error)}`,
        );
      }
    }
    const retained = await retain(true);
    await reconcileAll(retained.cleanup);
    const work = retained.work;
    for (const generation of eligible.values()) {
      const { source, intent, demandAtMs, expiresAtMs } = generation;
      if (!intent) {
        continue;
      }
      const limits = policy(source);
      const project = readWorkerProjectSnapshot(intent.profileSnapshot.project)!;
      for (let index = 0; index < generation.slots!; index += 1) {
        current();
        const admitted = await store.ensurePreparedIntent({
          intent: {
            ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
            providerId: intent.providerId,
            profileId: source.profileId,
            profileSnapshot: intent.profileSnapshot,
            preparation: {
              purpose: "reserve",
              key: intent.preparationKey!,
              demandAtMs,
              expiresAtMs,
            },
          },
          projectKey: project.key,
          ...limits,
          assertCurrent: () => {
            if (!isGenerationCurrent(generation)) {
              throw new Error("Prepared worker contents changed before allocation");
            }
            if (!isDeepStrictEqual(policy(source), limits)) {
              throw new Error("Prepared worker admission policy changed");
            }
          },
        });
        if (!admitted) {
          break;
        }
        work.push(admitted);
      }
    }
    await reconcileAll(work);
  };
  const schedule = () => {
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
  const noteDemand = async (environmentId: string) => {
    current();
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
      { leaseId: record.leaseId, profile: snapshotSettings(record) },
      {
        preparationKey: preparation.key,
        demandAtMs,
      },
    );
  };
  const candidates = (intent: WorkerProviderPreparedIntent) =>
    intent.preparationKey
      ? store.list().filter((record) => {
          const limits = policy(record);
          return (
            limits.target > 0 &&
            limits.maxTotal > 0 &&
            record.state === "ready" &&
            record.providerId === intent.providerId &&
            record.preparation !== null &&
            record.preparation.key === intent.preparationKey &&
            record.preparation.consumedAtMs === null &&
            record.preparation.expiresAtMs > now() &&
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
  const canPruneDemand = (record: WorkerEnvironmentRecord, nowMs: number): boolean => {
    const demandAtMs = demandAt(record);
    if (demandAtMs === undefined || !readWorkerProjectPreparation(record.profileSnapshot.project)) {
      return true;
    }
    // Unavailable policy cannot prove expiry. Retain metadata only; physical
    // cleanup is independent and must not wait for a provider to return.
    try {
      const timeout = options
        .resolveProvider(record.providerId)
        ?.resolvePreparedIdleTimeoutMs?.(snapshotSettings(record));
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
    if (record?.preparation && (await retire(record, "invalidated"))) {
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
      maxTotal: options.getConfig().cloudWorkers?.preparedPool?.maxTotal ?? DEFAULT_MAX_TOTAL,
      reservedEnvironmentIds: store.preparedReservationEnvironmentIds(),
    }),
    target: (profileId: string) => configuredPolicy(profileId).target,
  };
}
