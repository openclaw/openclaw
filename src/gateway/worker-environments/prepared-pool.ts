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
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

const DEFAULT_READY_WORKERS = 1;
const DEFAULT_MAX_TOTAL = 4;
const PREPARATION_CONCURRENCY = 2;

type PoolOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareIntent: (
    profileId: string,
    options: {
      projectPath?: string;
      projectCommit?: string;
      runSetupScript?: boolean;
      machineClass?: string;
      os?: string;
      executionMode?: "worker-turn" | "remote-exec";
      setupAuthorized?: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<WorkerProviderPreparedIntent>;
  assertIntentCurrent: (profileId: string, intent: WorkerProviderPreparedIntent) => void;
  prepareRetention: (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
  ) => Promise<{ assertCurrent: () => void } | undefined>;
  reconcile: (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
    beforeReconcile: () => void,
  ) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
  warn: (message: string) => void;
};

/** Environment rows own reserve inventory; placement activation establishes fresh demand. */
export function createPreparedWorkerPool(options: PoolOptions) {
  const { store, signal, now } = options;
  let inFlight: Promise<void> | undefined;
  let requested = false;
  const current = () => signal.throwIfAborted();
  const policy = (record: Pick<WorkerEnvironmentRecord, "profileId" | "providerId">) => {
    const config = options.getConfig().cloudWorkers;
    const profile = config?.profiles?.[record.profileId];
    return {
      target:
        profile && normalizeCapabilityProviderId(profile.provider) === record.providerId
          ? (profile.readyWorkers ?? DEFAULT_READY_WORKERS)
          : 0,
      maxTotal: config?.preparedPool?.maxTotal ?? DEFAULT_MAX_TOTAL,
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
      return;
    }
    store.requestPreparedDestroy({
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
    current();
    const sources = new Map<string, { record: WorkerEnvironmentRecord; demandAtMs: number }>();
    for (const record of store.list()) {
      const demandAtMs = demandAt(record);
      const key = groupKey(record);
      if (
        key &&
        demandAtMs !== undefined &&
        readWorkerProjectPreparation(record.profileSnapshot.project)
      ) {
        const previous = sources.get(key);
        if (!previous || demandAtMs > previous.demandAtMs) {
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
        retention?: { assertCurrent: () => void };
        intent?: WorkerProviderPreparedIntent;
        slots?: number;
      }
    >();
    for (const [key, { record, demandAtMs }] of sources) {
      const limits = policy(record);
      if (limits.target === 0 || limits.maxTotal === 0) {
        continue;
      }
      try {
        const timeout = options
          .resolveProvider(record.providerId)
          ?.resolvePreparedIdleTimeoutMs?.(snapshotSettings(record));
        if (
          Number.isSafeInteger(timeout) &&
          timeout &&
          timeout > 0 &&
          demandAtMs + timeout > now()
        ) {
          eligible.set(key, {
            source: record,
            preparationKey: readWorkerProjectPreparation(record.profileSnapshot.project)!.key,
            demandAtMs,
            expiresAtMs: demandAtMs + timeout,
          });
        }
      } catch {
        current();
        options.warn(
          `Prepared worker policy is unavailable (${record.profileId}); unused workers will retire`,
        );
      }
    }
    const assertGenerationCurrent = (generation: NonNullable<ReturnType<typeof eligible.get>>) => {
      current();
      generation.retention!.assertCurrent();
      if (generation.intent) {
        options.assertIntentCurrent(generation.source.profileId, generation.intent);
      }
      if (
        !isDeepStrictEqual(
          store.get(generation.source.environmentId)?.profileSnapshot,
          generation.source.profileSnapshot,
        )
      ) {
        throw new Error("Prepared worker source changed during maintenance");
      }
    };
    const reconcile = async (record: WorkerEnvironmentRecord) => {
      current();
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
          retire(owned, "expired");
        } else if (
          !generation?.retention ||
          generation.preparationKey !== owned.preparation.key ||
          !store.isPreparedIntentWithinCapacity({
            environmentId: owned.environmentId,
            ...policy(owned),
          })
        ) {
          retire(owned, "invalidated");
        } else {
          try {
            assertGenerationCurrent(generation);
          } catch {
            current();
            // Queued allocation may already own a lease. Preserve its cleanup
            // obligation even when local policy or admission changed while waiting.
            retire(owned, "invalidated");
          }
        }
      };
      beforeReconcile();
      const latest = store.get(record.environmentId);
      if (latest?.preparation?.consumedAtMs === null) {
        await options.reconcile(latest, signal, beforeReconcile);
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
    const retain = (requireRetention: boolean) => {
      const kept = new Map<string, number>();
      let totalKept = 0;
      const cleanup: WorkerEnvironmentRecord[] = [];
      const work: WorkerEnvironmentRecord[] = [];
      for (const record of store.list().toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
        if (
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
          (!requireRetention || generation.retention !== undefined) &&
          count < limits.target &&
          totalKept < limits.maxTotal;
        if (record.destroyRequestedAtMs === null && !valid) {
          retire(record, expired ? "expired" : "invalidated");
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
        } else {
          work.push(latest);
        }
      }
      return { cleanup, work };
    };
    // Expiry and disabled/surplus capacity need no source or artifact admission.
    // Drain that cleanup first so unrelated GitHub latency cannot hold its owner.
    await reconcileAll(retain(false).cleanup);
    for (const [key, generation] of eligible) {
      try {
        generation.retention = await options.prepareRetention(generation.source, signal);
        current();
        if (!generation.retention) {
          eligible.delete(key);
        }
      } catch {
        current();
        eligible.delete(key);
        options.warn(
          `Prepared worker contents are no longer compatible (${generation.source.profileId}); unused workers will retire`,
        );
      }
    }
    await reconcileAll(retain(true).cleanup);
    let plannedTotal = 0;
    for (const [key, generation] of eligible) {
      current();
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
          projectPath: project.root,
          projectCommit: project.baseCommit,
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
      } catch {
        current();
        eligible.delete(key);
        options.warn(
          `Prepared worker source is unavailable (${source.profileId}); unused workers will retire`,
        );
      }
    }
    const retained = retain(true);
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
        const admitted = store.ensurePreparedIntent({
          intent: {
            ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
            providerId: intent.providerId,
            profileId: source.profileId,
            profileSnapshot: intent.profileSnapshot,
            preparation: { key: intent.preparationKey!, demandAtMs, expiresAtMs },
          },
          projectKey: project.key,
          ...limits,
          assertCurrent: () => {
            assertGenerationCurrent(generation);
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
    await schedule().catch(() => {
      if (!signal.aborted) {
        options.warn("Prepared worker maintenance failed; cleanup will retry");
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
  return { schedule, noteDemand, candidates, maintain, canPruneDemand };
}
