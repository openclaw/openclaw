import { randomUUID } from "node:crypto";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { workerPreparationSourceKey } from "./preparation-identity.schema.js";
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
              ...pool.poolPolicy(options, record.profileId, record.providerId),
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
    const reconstructing = ctx.preserveReconstructing?.(record) === true;
    const valid =
      !expired &&
      (reconstructing ||
        (!isSupersededPresenceReserve(record, ctx.activeDemand) &&
          generation?.preparation.key === record.preparation.key &&
          (!requireRetention || generation.retention !== undefined || generation.deferred))) &&
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
      !reconstructing &&
      !generation?.deferred &&
      (!generation?.presenceOwned || generation.activationEligible || ctx.presence.isDemandActive())
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
    // The foreground request owns repository preparation. Maintenance may still
    // expire/destroy it, but cannot reacquire its user-bound source or allocate.
    if (pool.isRequestScopedRepositoryBuild(generation.source)) {
      continue;
    }
    if (deferred && generation.presenceOwned && !generation.activationEligible) {
      continue;
    }
    try {
      generation.retention = await options.prepareRetention(
        generation.source,
        generation.preparation,
        signal,
        (reason) => pool.skipRefill(ctx, generation.source, reason),
      );
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
    const project = readWorkerProjectSnapshot(source.profileSnapshot.project);
    const capacity = {
      profileId: source.profileId,
      projectKey: workerPreparationSourceKey(source.profileSnapshot)!,
      ...limits,
    };
    const slots = store.preparedCapacity({
      ...capacity,
      maxTotal: Math.max(0, limits.maxTotal - plannedTotal),
    });
    if (
      generation.expiresAtMs <= now() ||
      (!presence.isDemandActive() &&
        demand &&
        generation.preparation.key === demand.preparationKey &&
        !generation.activationEligible)
    ) {
      pool.skipRefill(ctx, source, "prepared capacity demand expired or ended");
      continue;
    }
    if (slots === 0) {
      if (store.preparedCapacity({ ...capacity, maxTotal: Number.MAX_SAFE_INTEGER }) > 0) {
        pool.skipRefill(ctx, source, "shared prepared capacity reached");
      }
      continue;
    }
    try {
      const preparation = generation.preparation;
      const projectPreparation = "source" in preparation ? undefined : preparation;
      const intent = await options.prepareIntent(source.profileId, {
        ...(workerPreparationSourceKey(source.profileSnapshot) === "image"
          ? { imageReserve: true as const }
          : project
            ? "source" in project
              ? { projectRepository: project }
              : { projectPath: project.root, projectCommit: project.baseCommit }
            : { emptyWorkspace: true }),
        ...readWorkerProfileSelection(source.profileSnapshot),
        setupAuthorized:
          projectPreparation?.setupRecipe !== undefined &&
          projectPreparation.runSetupScript !== false,
        runSetupScript: projectPreparation?.runSetupScript,
        assertCurrent: generation.assertImagePolicyCurrent,
        signal,
      });
      signal.throwIfAborted();
      const admittedPreparation =
        intent.profileSnapshot.runtimePreparation ?? intent.profileSnapshot.project?.preparation;
      if (intent.providerId !== source.providerId || admittedPreparation?.key !== preparation.key) {
        pool.skipRefill(ctx, source, "refill intent no longer matches the activated preparation");
        eligible.delete(key);
        continue;
      }
      generation.intent = intent;
      generation.slots = slots;
      plannedTotal += slots;
    } catch (error) {
      signal.throwIfAborted();
      ctx.reportRefill(
        `Prepared worker refill deferred (${source.profileId}, ${source.environmentId}): ${boundedWorkerError(error)}`,
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
    for (let index = 0; index < generation.slots!; index += 1) {
      signal.throwIfAborted();
      const admitted = await store.ensurePreparedIntent({
        intent: {
          ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
          providerId: intent.providerId,
          profileId: source.profileId,
          profileSnapshot: intent.profileSnapshot,
          preparation: {
            purpose: "reserve",
            key: generation.preparation.key,
            demandAtMs,
            expiresAtMs,
          },
        },
        projectKey:
          intent.profileSnapshot.runtimePreparation?.source ?? intent.profileSnapshot.project!.key,
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
  reportRefill: (message: string) => void,
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
    preserveReconstructing: presence.captureReconstruction(),
    inventory,
    oldestFirst: inventory.toSorted((a, b) => a.createdAtMs - b.createdAtMs),
    reportRefill,
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
