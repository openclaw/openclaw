import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
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
import type { WorkerEnvironmentRecord as Environment } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";
export type Generation = {
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
export const DEFAULT_MAX_TOTAL = 4;
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
export const groupKey = (record: Environment) => {
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
export function poolPolicy(options: PoolOptions, profileId: string, providerId?: string) {
  const config = options.getConfig().cloudWorkers;
  const profile = config?.profiles?.[profileId];
  const configuredProvider = profile ? normalizeCapabilityProviderId(profile.provider) : undefined;
  const configured = providerId === undefined || configuredProvider === providerId;
  const target = profile && configured ? (profile.readyWorkers ?? 1) : 0;
  return { configured, target, maxTotal: config?.preparedPool?.maxTotal ?? DEFAULT_MAX_TOTAL };
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
export type Generations = Map<string, Generation>;
export type PassContext = Readonly<{
  options: Readonly<PoolOptions>;
  presence: ReturnType<typeof createPreparedPoolPresence>;
  preparations: Map<string, AbortController>;
  isAdmitted: () => boolean;
  activeDemand: ReturnType<PassContext["presence"]["current"]>;
  presenceDeferred: boolean;
  inventory: readonly Environment[];
  oldestFirst: readonly Environment[];
}>;
export function deferGeneration(ctx: PassContext, generation: Generation, error: unknown): void {
  generation.deferred = true;
  ctx.options.warn(
    `Prepared worker maintenance deferred (${generation.source.profileId}); retaining unused capacity until its original expiry: ${boundedWorkerError(error)}`,
  );
}
export function admitSources(ctx: PassContext): Generations {
  const { options, inventory: rows, activeDemand: demand, presenceDeferred: deferred } = ctx;
  const { signal, now } = options;
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
    const limits = poolPolicy(options, record.profileId, record.providerId);
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
      signal.throwIfAborted();
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
      deferGeneration(ctx, generation, error);
      if (expiresAtMs > now()) {
        eligible.set(key, generation);
      }
    }
  }
  return eligible;
}
export function assertGenerationCurrent(ctx: PassContext, generation: Generation): void {
  const { options, presence, isAdmitted } = ctx;
  options.signal.throwIfAborted();
  if (generation.presenceOwned && !generation.activationEligible) {
    if (!isAdmitted() || !presence.isPresent()) {
      throw new Error("Authenticated human presence is unavailable for preparation");
    }
  }
  if (!generation.retention?.isCurrent()) {
    throw new Error("Prepared worker contents changed before allocation");
  }
  if (generation.intent) {
    options.assertIntentCurrent(generation.source.profileId, generation.intent);
  }
}
