import type { DatabaseSync } from "node:sqlite";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { LegacyCronRepairState } from "../commands/doctor/cron/legacy-repair.js";
import type { LegacyCronMigrationSource } from "../commands/doctor/cron/legacy-store-migration.js";
import {
  readRetainedLegacyDefaultCronOwnerForStore,
  restoreRetainedLegacyDefaultCronOwnerHandoffInDatabase,
  restoreRetainedLegacyDefaultCronOwnerHandoffForStore,
  retainLegacyDefaultCronOwnerHandoffForStore,
  type RetainedLegacyCronOwnerHandoffSnapshot,
} from "../cron/legacy-default-agent-owner-handoff.js";
import { beginLegacyDefaultOwnerHandoff } from "../cron/live-service-registry.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import {
  mergePreparedCronOwnerRollbacks,
  rollbackMaterializedCronJobsStoreOwners,
  type PreparedCronOwnerRollback,
} from "../cron/store/owner-migration.js";
import {
  isValidAgentId,
  normalizeAgentId,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type CronOwnerHandoffTarget = {
  config: OpenClawConfig;
  storePath: string;
};

type CronStoreWritePlan = {
  recheckExplicitDestination?: () => Promise<void>;
  targets: CronOwnerHandoffTarget[];
};

function resolveExplicitCronOwner(job: unknown): string | undefined {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    return undefined;
  }
  const record = job as { agentId?: unknown; sessionKey?: unknown };
  const hasConfiguredAgentId = Object.hasOwn(record, "agentId");
  const rawAgentId = typeof record.agentId === "string" ? record.agentId.trim() : undefined;
  if (hasConfiguredAgentId && (!rawAgentId || !isValidAgentId(rawAgentId))) {
    throw new Error("cron job agentId must not be blank or malformed when supplied");
  }
  const configuredAgentId = normalizeOptionalAgentId(rawAgentId);
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : undefined;
  const scopedAgentId = normalizeOptionalAgentId(parseAgentSessionKey(sessionKey)?.agentId);
  if (configuredAgentId && scopedAgentId && configuredAgentId !== scopedAgentId) {
    throw new Error(
      `cron job agentId ${configuredAgentId} does not match sessionKey owner ${scopedAgentId}`,
    );
  }
  return configuredAgentId ?? scopedAgentId;
}

/** Refuses a store switch that would publish ownerless jobs under explicit ownership. */
async function assertCronStoreDestinationHasExplicitOwners(params: {
  config: OpenClawConfig;
  storePath: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { loadLegacyCronRepairState } = await import("../commands/doctor/cron/legacy-repair.js");
  const state = await loadLegacyCronRepairState({
    cfg: {},
    storePath: params.storePath,
    env: params.env,
    readOnly: true,
  });
  const eligibleAgentIds = new Set(listAgentIds(params.config).map(normalizeAgentId));
  const rawJobs = state?.rawJobs ?? [];
  const ownerlessJobs = rawJobs.filter((job) => !resolveExplicitCronOwner(job));
  const unavailableJobs = rawJobs.filter((job) => {
    const owner = resolveExplicitCronOwner(job);
    return owner !== undefined && !eligibleAgentIds.has(owner);
  });
  if (ownerlessJobs.length > 0) {
    // Once explicit ownership publishes, no ambient owner remains to repair this store later.
    // Refuse before the config points at it rather than silently orphaning scheduled work.
    throw new Error(
      `Config write refused: cron.store destination ${params.storePath} contains ${ownerlessJobs.length} ownerless legacy cron job(s). Assign every destination job an explicit agentId with openclaw cron edit, or repair the destination with openclaw doctor --fix while its legacy owner is still available, then retry the store change.`,
    );
  }
  if (unavailableJobs.length > 0) {
    throw new Error(
      `Config write refused: cron.store destination ${params.storePath} contains ${unavailableJobs.length} cron job(s) owned by agents absent from the incoming roster. Reassign those jobs with openclaw cron edit before retrying the store change.`,
    );
  }
}

/** Validates a cron store switch and plans any same-store legacy-owner handoff. */
export async function planCronStoreWrite(params: {
  cronHandoffAgentId?: string;
  env: NodeJS.ProcessEnv;
  nextConfig: OpenClawConfig;
  publishesExplicitOwnership: boolean;
  requiresCurrentStoreValidation: boolean;
  sourceConfig: OpenClawConfig;
}): Promise<CronStoreWritePlan> {
  const sourceStorePath = resolveCronJobsStorePathFromConfig(params.sourceConfig, params.env);
  const destinationStorePath = resolveCronJobsStorePathFromConfig(params.nextConfig, params.env);
  const recheckExplicitDestination =
    params.publishesExplicitOwnership &&
    (sourceStorePath !== destinationStorePath ||
      (params.requiresCurrentStoreValidation && !params.cronHandoffAgentId))
      ? async () =>
          await assertCronStoreDestinationHasExplicitOwners({
            config: params.nextConfig,
            storePath: destinationStorePath,
            env: params.env,
          })
      : undefined;
  await recheckExplicitDestination?.();
  if (!params.cronHandoffAgentId) {
    return { recheckExplicitDestination, targets: [] };
  }
  if (sourceStorePath !== destinationStorePath) {
    throw new Error(
      `Config write refused: cron ownership migration cannot be committed atomically while cron.store changes from ${sourceStorePath} to ${destinationStorePath}. Keep cron.store unchanged while ownership is materialized; before a later store-only switch, assign explicit agentId values to every destination job because the explicit roster has no ambient fallback owner.`,
    );
  }
  return {
    recheckExplicitDestination,
    targets: [{ storePath: sourceStorePath, config: params.sourceConfig }],
  };
}

/** Seals and migrates every cron store until the config write commits or fails. */
export async function prepareLegacyCronOwnerHandoffs(params: {
  env: NodeJS.ProcessEnv;
  legacyDefaultAgentId: string;
  targets: readonly CronOwnerHandoffTarget[];
}): Promise<{ release: () => void; rollback: () => Promise<void> }> {
  const handoffs: Array<ReturnType<typeof beginLegacyDefaultOwnerHandoff>> = [];
  const rollbackPlans: Array<{
    handoff: ReturnType<typeof beginLegacyDefaultOwnerHandoff>;
    committedStoreEpoch?: number;
    legacyDefaultAgentId: string;
    legacyMigrationSource?: LegacyCronMigrationSource;
    repairState?: LegacyCronRepairState | null;
    legacyReceiptCreated?: boolean;
    initialStoreEpoch?: number;
    preparedRollback?: PreparedCronOwnerRollback;
    receiptAfter?: RetainedLegacyCronOwnerHandoffSnapshot;
    receiptBefore?: RetainedLegacyCronOwnerHandoffSnapshot;
    receiptCaptured: boolean;
    storePath: string;
  }> = [];
  let rollbackLegacyMigrationReceipt:
    | ((db: DatabaseSync, source: LegacyCronMigrationSource) => void)
    | undefined;
  let rolledBack = false;
  const release = () => {
    for (const handoff of handoffs) {
      handoff.release();
    }
  };
  const rollback = async () => {
    if (rolledBack) {
      return;
    }
    rolledBack = true;
    const rollbackErrors: unknown[] = [];
    for (const plan of rollbackPlans.toReversed()) {
      try {
        if (plan.preparedRollback) {
          await rollbackMaterializedCronJobsStoreOwners({
            rollback: plan.preparedRollback,
            restoreMetadata: (db) => {
              if (plan.receiptCaptured) {
                restoreRetainedLegacyDefaultCronOwnerHandoffInDatabase(
                  db,
                  plan.storePath,
                  plan.receiptBefore,
                  { expectedCurrent: plan.receiptAfter },
                );
              }
              if (plan.legacyReceiptCreated && plan.legacyMigrationSource) {
                rollbackLegacyMigrationReceipt?.(db, plan.legacyMigrationSource);
              }
            },
            env: params.env,
          });
        } else if (plan.receiptCaptured) {
          restoreRetainedLegacyDefaultCronOwnerHandoffForStore(
            plan.storePath,
            plan.receiptBefore,
            params.env,
            { expectedCurrent: plan.receiptAfter },
          );
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
      try {
        await plan.handoff.refreshSealedServices();
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(rollbackErrors, "one or more cron ownership rollbacks failed");
    }
  };
  try {
    const { loadLegacyCronRepairState, materializeLegacyDefaultCronJobOwners } =
      await import("../commands/doctor/cron/legacy-repair.js");
    ({ rollbackLegacyCronMigrationReceiptInDatabase: rollbackLegacyMigrationReceipt } =
      await import("../commands/doctor/cron/migration-ledger.js"));
    for (const target of params.targets) {
      // Receipts belong to physical stores, not the config selecting them. A destination
      // can carry an older owner's late-writer handoff and must keep that authority.
      const legacyDefaultAgentId =
        readRetainedLegacyDefaultCronOwnerForStore(target.storePath, params.env) ??
        params.legacyDefaultAgentId;
      const rollbackPlan: (typeof rollbackPlans)[number] = {
        handoff: undefined as unknown as ReturnType<typeof beginLegacyDefaultOwnerHandoff>,
        legacyDefaultAgentId,
        receiptCaptured: false,
        storePath: target.storePath,
      };
      const handoff = beginLegacyDefaultOwnerHandoff({
        storePath: target.storePath,
        legacyDefaultAgentId,
        beforeMigration: async () => {
          const initialStoreEpoch = (
            await loadCronJobsStoreWithConfigJobsReadOnly(target.storePath, params.env)
          ).storeEpoch;
          const repairState = await loadLegacyCronRepairState({
            cfg: target.config,
            storePath: target.storePath,
            env: params.env,
            readOnly: true,
          });
          rollbackPlan.repairState = repairState;
          rollbackPlan.legacyMigrationSource = repairState?.legacyMigrationSource;
          const verifiedStoreEpoch = (
            await loadCronJobsStoreWithConfigJobsReadOnly(target.storePath, params.env)
          ).storeEpoch;
          if (verifiedStoreEpoch !== initialStoreEpoch) {
            throw new Error("cron store changed while preparing owner handoff; retry config write");
          }
          rollbackPlan.initialStoreEpoch = initialStoreEpoch;
        },
        expectedStoreEpoch: () => rollbackPlan.initialStoreEpoch,
        recordCommittedStoreEpoch: (storeEpoch) => {
          rollbackPlan.committedStoreEpoch = storeEpoch;
        },
        recordPreparedRollback: (prepared) => {
          rollbackPlan.preparedRollback = mergePreparedCronOwnerRollbacks(
            rollbackPlan.preparedRollback,
            prepared,
          );
        },
      });
      handoffs.push(handoff);
      rollbackPlan.handoff = handoff;
      rollbackPlans.push(rollbackPlan);
      const liveMigration = await handoff.drainAndSeal();
      if (liveMigration.warnings.length > 0) {
        throw new Error(
          `Config write refused before live cron ownership was durable: ${liveMigration.warnings.join(" ")}`,
        );
      }
      const postDrainEpoch = rollbackPlan.preparedRollback?.expectedStoreEpoch;
      const migration = await materializeLegacyDefaultCronJobOwners({
        cfg: target.config,
        storePath: target.storePath,
        env: params.env,
        legacyDefaultAgentId,
        expectedStoreEpoch: postDrainEpoch,
        repairState: rollbackPlan.repairState,
        recordCommittedStoreEpoch: (storeEpoch) => {
          rollbackPlan.committedStoreEpoch = storeEpoch;
        },
        recordPreparedRollback: (prepared) => {
          rollbackPlan.preparedRollback = mergePreparedCronOwnerRollbacks(
            rollbackPlan.preparedRollback,
            prepared,
          );
        },
        recordLegacyReceiptCreated: () => {
          rollbackPlan.legacyReceiptCreated = true;
        },
      });
      if (migration.warnings.length > 0) {
        throw new Error(
          `Config write refused before retired default ownership was durable: ${migration.warnings.join(" ")}`,
        );
      }
      // A CLI process cannot fence a separately running pre-upgrade Gateway.
      // Persist this after row migration but before config commit so late rows migrate at startup.
      const receiptMutation = retainLegacyDefaultCronOwnerHandoffForStore(
        target.storePath,
        legacyDefaultAgentId,
        params.env,
      );
      rollbackPlan.receiptBefore = receiptMutation.before;
      rollbackPlan.receiptAfter = receiptMutation.after;
      rollbackPlan.receiptCaptured = true;
      await handoff.refreshSealedServices();
    }
    return { release, rollback };
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new Error(
        `cron ownership handoff failed (${error instanceof Error ? error.message : String(error)}) and rollback did not complete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: rollbackError },
      );
    } finally {
      release();
    }
    throw error;
  }
}
