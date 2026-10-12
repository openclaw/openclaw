import { randomUUID } from "node:crypto";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import {
  type createPreparedPoolPresence,
  isSupersededPresenceReserve,
  matchingPreparedPoolPresenceDemand,
  type PreparedPoolPresenceOptions,
} from "./prepared-pool-presence.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type {
  createWorkerProviderIntent,
  WorkerProviderIntentPreparationOptions,
} from "./provider-intent.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { readWorkerProfileSelection } from "./service-validation.js";
import type { WorkerEnvironmentRecord as Environment } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";
type Generation = {
  source: Environment;
  preparationKey: string;
  demandAtMs: number;
  expiresAtMs: number;
  retention?: { isCurrent: () => boolean };
  deferred?: boolean;
  activationEligible?: boolean;
  presenceOwned?: boolean;
  intent?: WorkerProviderPreparedIntent;
  slots?: number;
};
const DEFAULT_READY_WORKERS = 1;
export const DEFAULT_MAX_TOTAL = 4;
const PREPARATION_CONCURRENCY = 2;
export type PoolOptions = Omit<PreparedPoolPresenceOptions, "schedule" | "prepareIntent"> & {
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareIntent: (
    profileId: string,
    options: WorkerProviderIntentPreparationOptions,
  ) => Promise<WorkerProviderPreparedIntent>;
  prepareRetention: ReturnType<typeof createWorkerProviderIntent>["prepareRetention"];
  reconcile: (record: Environment, signal: AbortSignal, before: () => void) => Promise<void>;
  warn: (message: string) => void;
};
const groupKey = (record: Environment) => {
  const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
  return project ? JSON.stringify([record.providerId, record.profileId, project.key]) : undefined;
};
// Failed claims inherit only the original preparation window; success records
// a separate fact that survives teardown and placement retirement.
export const demandAt = (record: Environment) =>
  record.lastActivatedAtMs ?? record.preparation?.demandAtMs;
export const snapshotSettings = (record: Environment) => {
  const settings = record.profileSnapshot.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Prepared worker profile settings are unavailable");
  }
  return settings;
};
export function configuredPoolPolicy(options: PoolOptions, profileId: string) {
  const config = options.getConfig().cloudWorkers;
  const profile = config?.profiles?.[profileId];
  return {
    providerId: profile ? normalizeCapabilityProviderId(profile.provider) : undefined,
    target: profile ? (profile.readyWorkers ?? DEFAULT_READY_WORKERS) : 0,
    maxTotal: config?.preparedPool?.maxTotal ?? DEFAULT_MAX_TOTAL,
  };
}
export function poolPolicy(opts: PoolOptions, row: Pick<Environment, "profileId" | "providerId">) {
  const config = configuredPoolPolicy(opts, row.profileId);
  const configured = config.providerId === row.providerId;
  return { configured, target: configured ? config.target : 0, maxTotal: config.maxTotal };
}
export function retirePoolRecord(
  options: PoolOptions,
  record: Environment,
  reason: "expired" | "invalidated",
) {
  if (!record.preparation) {
    return undefined;
  }
  return options.store.requestPreparedDestroy({
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    preparationKey: record.preparation.key,
    reason,
    assertCurrent: () => options.signal.throwIfAborted(),
  });
}
export async function runPreparedPoolPass(
  options: PoolOptions,
  presence: ReturnType<typeof createPreparedPoolPresence>,
  preparations: Map<string, AbortController>,
  isAdmitted: () => boolean,
) {
  const { store, signal, now } = options;
  const current = () => signal.throwIfAborted();
  await store.ready();
  current();
  const activeDemand = presence.current();
  const presenceDeferred = !isAdmitted();
  const inventory = store.list();
  const oldestFirst = inventory.toSorted((a, b) => a.createdAtMs - b.createdAtMs);
  const defer = (generation: Generation, error: unknown) => {
    generation.deferred = true;
    options.warn(
      `Prepared worker maintenance deferred (${generation.source.profileId}); retaining unused capacity until its original expiry: ${boundedWorkerError(error)}`,
    );
  };
  function admitSources(rows: Environment[], demand: typeof activeDemand, deferred: boolean) {
    const sources = new Map<string, { record: Environment; demandAtMs: number }>();
    const activationByGeneration = new Map<string, number>();
    const buildingKeys = new Set<string>();
    for (const record of rows) {
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
      // Exclude superseded presence generations before choosing the newest
      // demand, so a later old-base activation cannot hide current reserves.
      // Consumed workers remain owned by their active placements.
      if (
        demand &&
        (demand.retireAtMs ?? Infinity) > now() &&
        demand.profileId === record.profileId &&
        demand.project.key === readWorkerProjectSnapshot(record.profileSnapshot.project)?.key &&
        demand.preparationKey !== record.preparation?.key
      ) {
        continue;
      }
      if (isSupersededPresenceReserve(record, demand)) {
        continue;
      }
      const preparation = readWorkerProjectPreparation(record.profileSnapshot.project);
      if (key && demandAtMs !== undefined && preparation) {
        if (record.lastActivatedAtMs !== null) {
          const generationKey = JSON.stringify([key, preparation.key]);
          activationByGeneration.set(
            generationKey,
            Math.max(
              activationByGeneration.get(generationKey) ?? record.lastActivatedAtMs,
              record.lastActivatedAtMs,
            ),
          );
        }
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
    const eligible = new Map<string, Generation>();
    for (const [key, { record, demandAtMs }] of sources) {
      const limits = poolPolicy(options, record);
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
        const presenceOwned = matchingPreparedPoolPresenceDemand(record, demand);
        const presenceExpiresAtMs = demand?.retireAtMs ?? Number.MAX_SAFE_INTEGER;
        // A newer spare may supply the snapshot, but only this exact generation's
        // real activation can supply its independent foreground demand deadline.
        const activationDemandAtMs = presenceOwned
          ? activationByGeneration.get(JSON.stringify([key, preparationKey]))
          : demandAtMs;
        const activationExpiresAtMs =
          activationDemandAtMs !== undefined &&
          Number.isSafeInteger(timeout) &&
          timeout &&
          timeout > 0
            ? activationDemandAtMs + timeout
            : undefined;
        const activationEligible =
          activationExpiresAtMs !== undefined && activationExpiresAtMs > now();
        if ((presenceOwned && presenceExpiresAtMs > now()) || activationEligible) {
          eligible.set(key, {
            source: record,
            preparationKey,
            demandAtMs: presenceOwned
              ? Math.max(presenceOwned.lastPresentAtMs, demandAtMs)
              : demandAtMs,
            expiresAtMs: Math.max(
              presenceOwned ? presenceExpiresAtMs : 0,
              activationExpiresAtMs ?? 0,
            ),
            presenceOwned: Boolean(presenceOwned),
            deferred: Boolean(presenceOwned && deferred && !activationEligible),
            activationEligible,
          });
        }
      } catch (error) {
        current();
        // Unknown provider policy cannot renew demand or invalidate an already owned lease.
        const expiresAtMs = rows.reduce((latest, reserved) => {
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
    return eligible;
  }
  const eligible = admitSources(inventory, activeDemand, presenceDeferred);
  const isGenerationCurrent = (generation: Generation) => {
    current();
    if (generation.presenceOwned && !generation.activationEligible) {
      if (!isAdmitted() || !presence.isPresent()) {
        throw new Error("Authenticated human presence is unavailable for preparation");
      }
    }
    if (!generation.retention?.isCurrent()) {
      return false;
    }
    if (generation.intent) {
      options.assertIntentCurrent(generation.source.profileId, generation.intent);
    }
    return true;
  };
  const reconcile = async (record: Environment) => {
    current();
    const key = groupKey(record);
    const generation = key ? eligible.get(key) : undefined;
    const limits = poolPolicy(options, record);
    const beforeReconcile = () => {
      current();
      if (record.destroyRequestedAtMs === null && generation) {
        if (generation.deferred) {
          throw new Error("Prepared worker maintenance is deferred");
        }
        if (!isGenerationCurrent(generation)) {
          throw new Error("Prepared worker contents changed before allocation");
        }
        if (
          !store.isPreparedIntentWithinCapacity({
            environmentId: record.environmentId,
            ...limits,
          })
        ) {
          throw new Error("Prepared worker no longer satisfies its maintenance policy");
        }
      }
    };
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
      } finally {
        preparations.delete(record.environmentId);
      }
    }
  };
  const reconcileAll = (records: Environment[]) =>
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
    const cleanup: Environment[] = [];
    const work: Environment[] = [];
    // Builds admitted during an await belong to the next scheduled pass's
    // source snapshot. Existing rows still use live promotion and cleanup state.
    for (const snapshot of oldestFirst) {
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
      const limits = poolPolicy(options, record);
      const count = key ? (kept.get(key) ?? 0) : 0;
      const expired =
        record.preparation.expiresAtMs <= now() ||
        (generation !== undefined && generation.expiresAtMs <= now());
      const valid =
        !isSupersededPresenceReserve(record, activeDemand) &&
        !expired &&
        generation?.preparationKey === record.preparation.key &&
        (!requireRetention || generation.retention !== undefined || generation.deferred) &&
        ((record.preparation.purpose === "build" && record.state !== "ready") ||
          count < limits.target) &&
        totalKept < limits.maxTotal;
      if (record.destroyRequestedAtMs === null && !valid) {
        await retirePoolRecord(options, record, expired ? "expired" : "invalidated");
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
      } else if (
        !generation?.deferred &&
        (!generation?.presenceOwned || generation.activationEligible || presence.isPresent())
      ) {
        work.push(latest);
      }
    }
    return { cleanup, work };
  };
  async function planRefill(pool: typeof eligible, demand: typeof activeDemand, deferred: boolean) {
    for (const [key, generation] of pool) {
      if (deferred && generation.presenceOwned && !generation.activationEligible) {
        continue;
      }
      try {
        generation.retention = await options.prepareRetention(generation.source, signal);
        current();
        if (!generation.retention) {
          pool.delete(key);
        }
      } catch (error) {
        current();
        defer(generation, error);
      }
    }
    let plannedTotal = 0;
    for (const [key, generation] of pool) {
      current();
      if (generation.deferred) {
        continue;
      }
      const { source } = generation;
      const limits = poolPolicy(options, source);
      const project = readWorkerProjectSnapshot(source.profileSnapshot.project)!;
      const slots = store.preparedCapacity({
        profileId: source.profileId,
        projectKey: project.key,
        ...limits,
        maxTotal: Math.max(0, limits.maxTotal - plannedTotal),
      });
      if (
        slots === 0 ||
        generation.expiresAtMs <= now() ||
        (!presence.isPresent() &&
          demand &&
          generation.preparationKey === demand.preparationKey &&
          !generation.activationEligible)
      ) {
        continue;
      }
      try {
        const preparation = readWorkerProjectPreparation(source.profileSnapshot.project)!;
        const intent = await options.prepareIntent(source.profileId, {
          ...("source" in project
            ? { projectRepository: project }
            : { projectPath: project.root, projectCommit: project.baseCommit }),
          ...readWorkerProfileSelection(source.profileSnapshot),
          setupAuthorized:
            preparation.setupRecipe !== undefined && preparation.runSetupScript !== false,
          runSetupScript: preparation.runSetupScript,
          signal,
        });
        current();
        if (intent.providerId !== source.providerId || intent.preparationKey !== preparation.key) {
          pool.delete(key);
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
  }
  async function launchReserves(generations: typeof eligible, work: Environment[]) {
    for (const generation of generations.values()) {
      const { source, intent, demandAtMs, expiresAtMs } = generation;
      if (!intent) {
        continue;
      }
      const limits = poolPolicy(options, source);
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
          },
        });
        if (!admitted) {
          break;
        }
        work.push(admitted);
      }
    }
  }
  // Expiry and disabled/surplus capacity need no source or artifact admission.
  // Drain that cleanup first so unrelated GitHub latency cannot hold its owner.
  await reconcileAll((await retain(false)).cleanup);
  await planRefill(eligible, activeDemand, presenceDeferred);
  const retained = await retain(true);
  await reconcileAll(retained.cleanup);
  await launchReserves(eligible, retained.work);
  await reconcileAll(retained.work);
}
