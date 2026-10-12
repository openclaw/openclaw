import { randomUUID } from "node:crypto";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import type { Generations, PassContext, PoolOptions } from "./prepared-pool-admission.js";
import * as pool from "./prepared-pool-admission.js";
import { isSupersededPresenceReserve } from "./prepared-pool-presence.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { readWorkerProfileSelection } from "./service-validation.js";
import type { WorkerEnvironmentRecord as Environment } from "./store.js";
import { boundedWorkerError } from "./worker-error.js";
const PREPARATION_CONCURRENCY = 2;
type Retained = { cleanup: Environment[]; work: Environment[]; cleaned: Set<string> };
type Reconciled = ReturnType<typeof runTasksWithConcurrency<void>>;
function reconcileAll(ctx: PassContext, eligible: Generations, records: Environment[]): Reconciled {
  return runTasksWithConcurrency({
    tasks: records.map((record) => async () => {
      const { options } = ctx;
      const { store, signal } = options;
      signal.throwIfAborted();
      const key = pool.groupKey(record);
      const generation = key ? eligible.get(key) : undefined;
      const limits = pool.poolPolicy(options, record.profileId, record.providerId);
      const before = () => {
        signal.throwIfAborted();
        if (record.destroyRequestedAtMs === null && generation) {
          if (generation.deferred) {
            throw new Error("Prepared worker maintenance is deferred");
          }
          pool.assertGenerationCurrent(ctx, generation);
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
        ctx.preparations.set(record.environmentId, controller);
        try {
          await options.reconcile(latest, AbortSignal.any([signal, controller.signal]), before);
        } finally {
          ctx.preparations.delete(record.environmentId);
        }
      }
    }),
    limit: PREPARATION_CONCURRENCY,
    onTaskError: () => {
      if (!ctx.options.signal.aborted) {
        ctx.options.warn(
          "Prepared worker maintenance failed; inspect the recorded environment failure and cleanup state",
        );
      }
    },
  });
}
async function retain(
  ctx: PassContext,
  eligible: Generations,
  cleaned: Set<string>,
  requireRetention: boolean,
): Promise<Retained> {
  const { options } = ctx;
  const { store, now } = options;
  const kept = new Map<string, number>();
  let totalKept = 0;
  const cleanup: Environment[] = [];
  const work: Environment[] = [];
  // Builds admitted during an await belong to the next scheduled pass's
  // source snapshot. Existing rows still use live promotion and cleanup state.
  for (const snapshot of ctx.oldestFirst) {
    const record = store.get(snapshot.environmentId);
    if (
      !record ||
      record.preparation?.consumedAtMs !== null ||
      record.state === "destroyed" ||
      record.state === "failed"
    ) {
      continue;
    }
    options.signal.throwIfAborted();
    const key = pool.groupKey(record);
    const generation = key ? eligible.get(key) : undefined;
    const limits = pool.poolPolicy(options, record.profileId, record.providerId);
    const count = key ? (kept.get(key) ?? 0) : 0;
    const expired =
      record.preparation.expiresAtMs <= now() ||
      (generation !== undefined && generation.expiresAtMs <= now());
    const valid =
      !isSupersededPresenceReserve(record, ctx.activeDemand) &&
      !expired &&
      generation?.preparationKey === record.preparation.key &&
      (!requireRetention || generation.retention !== undefined || generation.deferred) &&
      ((record.preparation.purpose === "build" && record.state !== "ready") ||
        count < limits.target) &&
      totalKept < limits.maxTotal;
    if (record.destroyRequestedAtMs === null && !valid) {
      await pool.retirePoolRecord(options, record, expired ? "expired" : "invalidated");
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
      (!generation?.presenceOwned || generation.activationEligible || ctx.presence.isPresent())
    ) {
      work.push(latest);
    }
  }
  return { cleanup, work, cleaned };
}
async function planRefill(ctx: PassContext, eligible: Generations): Promise<Generations> {
  const { options, presence, activeDemand: demand, presenceDeferred: deferred } = ctx;
  const { store, signal, now } = options;
  for (const [key, generation] of eligible) {
    if (deferred && generation.presenceOwned && !generation.activationEligible) {
      continue;
    }
    try {
      generation.retention = await options.prepareRetention(generation.source, signal);
      signal.throwIfAborted();
      if (!generation.retention) {
        eligible.delete(key);
      }
    } catch (error) {
      signal.throwIfAborted();
      pool.deferGeneration(ctx, generation, error);
    }
  }
  let plannedTotal = 0;
  for (const [key, generation] of eligible) {
    signal.throwIfAborted();
    if (generation.deferred) {
      continue;
    }
    const { source } = generation;
    const limits = pool.poolPolicy(options, source.profileId, source.providerId);
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
      signal.throwIfAborted();
      if (intent.providerId !== source.providerId || intent.preparationKey !== preparation.key) {
        eligible.delete(key);
        continue;
      }
      generation.intent = intent;
      generation.slots = slots;
      plannedTotal += slots;
    } catch (error) {
      signal.throwIfAborted();
      options.warn(
        `Prepared worker refill deferred (${source.profileId}): ${boundedWorkerError(error)}`,
      );
    }
  }
  return eligible;
}
async function launchReserves(
  ctx: PassContext,
  eligible: Generations,
  work: Environment[],
): Promise<Environment[]> {
  const { options } = ctx;
  const { store, signal } = options;
  for (const generation of eligible.values()) {
    const { source, intent, demandAtMs, expiresAtMs } = generation;
    if (!intent) {
      continue;
    }
    const limits = pool.poolPolicy(options, source.profileId, source.providerId);
    const project = readWorkerProjectSnapshot(intent.profileSnapshot.project)!;
    for (let index = 0; index < generation.slots!; index += 1) {
      signal.throwIfAborted();
      const admitted = await store.ensurePreparedIntent({
        intent: {
          ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
          providerId: intent.providerId,
          profileId: source.profileId,
          profileSnapshot: intent.profileSnapshot,
          preparation: { purpose: "reserve", key: intent.preparationKey!, demandAtMs, expiresAtMs },
        },
        projectKey: project.key,
        ...limits,
        assertCurrent: () => pool.assertGenerationCurrent(ctx, generation),
      });
      if (!admitted) {
        break;
      }
      work.push(admitted);
    }
  }
  return work;
}
export async function runPreparedPoolPass(
  options: PoolOptions,
  presence: PassContext["presence"],
  preparations: Map<string, AbortController>,
  isAdmitted: () => boolean,
): Promise<void> {
  const { store, signal } = options;
  await store.ready();
  signal.throwIfAborted();
  const activeDemand = presence.current();
  const presenceDeferred = !isAdmitted();
  const inventory = store.list();
  const ctx: PassContext = {
    options,
    presence,
    preparations,
    isAdmitted,
    activeDemand,
    presenceDeferred,
    inventory,
    oldestFirst: inventory.toSorted((a, b) => a.createdAtMs - b.createdAtMs),
  };
  const eligible = pool.admitSources(ctx);
  // Expiry and disabled/surplus capacity need no source or artifact admission.
  // Drain that cleanup first so unrelated GitHub latency cannot hold its owner.
  const initial = await retain(ctx, eligible, new Set<string>(), false);
  await reconcileAll(ctx, eligible, initial.cleanup);
  const planned = await planRefill(ctx, eligible);
  const retained = await retain(ctx, planned, initial.cleaned, true);
  await reconcileAll(ctx, planned, retained.cleanup);
  const work = await launchReserves(ctx, planned, retained.work);
  await reconcileAll(ctx, planned, work);
}
