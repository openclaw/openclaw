// Read-only planning for the Doctor cron store repair; the repair writes from this plan.

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import { tryResolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "../../../cron/store.js";
import { prepareProviderModelPolicySurfaces } from "../../../plugins/provider-model-routes.js";
import type { LegacyCodexModelIdentity } from "../shared/codex-route-model-ref.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredModelSlots,
  repairModelRefAuthProfile,
} from "../shared/retired-model-ref-repair.js";
import { migrateLegacyNotifyFallback } from "./legacy-notify.js";
import type { LegacyCronQuarantine } from "./legacy-quarantine-migration.js";
import { planCronCodexRefRewriteAgainstPersistedConfig } from "./runtime-policy-migration.js";
import { assertCronStateSchemaSupportedAsync } from "./schema-safety.js";
import {
  canRepairCronDeliveryForDoctor,
  collectStoredCronCodexRuntimePolicyTargets,
  cronCodexRuntimePolicyTargetKey,
  normalizeStoredCronJobs,
  recoverValidQuarantinedCronScheduleJobs,
} from "./store-migration.js";
import type { inspectCronJobOwnersForDoctor } from "./store-repair.js";

export type CronOwnerProjection =
  | { kind: "explicit"; agentId: string }
  | { kind: "runtime-default"; agentId: string }
  | { kind: "unresolved" };

export type LegacyCronRepairState = {
  storePath: string;
  legacyQuarantine?: LegacyCronQuarantine;
  invalidConfigRows: QuarantinedCronConfigJob[];
  persistedQuarantine: CronQuarantinedJob[];
  projectedOwnersByJobId: ReadonlyMap<string, CronOwnerProjection>;
  rawJobs: Array<Record<string, unknown>>;
  jobsFingerprint: string | undefined;
  ownerRows: Awaited<ReturnType<typeof inspectCronJobOwnersForDoctor>>;
  legacyImport?: { count: number; assertCurrent: () => void };
};

export type LegacyCronStoreRepairParams = {
  cfg: OpenClawConfig;
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  modelReplacements?: readonly import("../shared/model-replacement.js").DoctorModelReplacement[];
  authProfileIdMap?: ReadonlyMap<string, string>;
  state: LegacyCronRepairState;
  normalized?: ReturnType<typeof normalizeStoredCronJobs>;
  migrateCodexModelRefs?: boolean;
  repairRetiredModelRefs?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  recoverQuarantinedScheduleJobs?: boolean;
};

/**
 * Plans the repair against `state` (rewriting its in-memory jobs) without touching storage.
 * The repair writes only when `changed`; a read-only state makes this a pending check.
 */
export async function planLegacyCronStoreRepair(params: LegacyCronStoreRepairParams) {
  await assertCronStateSchemaSupportedAsync();
  await prepareProviderModelPolicySurfaces();
  const { state } = params;
  const changes: string[] = [];
  const warnings: string[] = [];
  // Earlier legacy migrations do not authorize retiring current model choices.
  const resolveRetired =
    params.repairRetiredModelRefs === true
      ? createRetiredModelRefRepairResolver({
          cfg: params.cfg,
          modelReplacements: params.modelReplacements,
          checkModelPolicy: true,
          retiredModelRefConfig: params.retiredModelRefConfig,
          authProfileIdMap: params.authProfileIdMap,
          warnings,
        })
      : params.authProfileIdMap?.size
        ? ({ modelRef }: { modelRef: string }) =>
            repairModelRefAuthProfile(modelRef, params.authProfileIdMap)
        : undefined;
  const quarantineEntriesToRevalidate =
    params.recoverQuarantinedScheduleJobs === true
      ? [...state.persistedQuarantine, ...(state.legacyQuarantine?.jobs ?? [])]
      : [];
  const persistedQuarantineEntrySet = new Set<QuarantinedCronConfigJob | CronQuarantinedJob>(
    state.persistedQuarantine,
  );
  const quarantineRecovery = recoverValidQuarantinedCronScheduleJobs(
    quarantineEntriesToRevalidate,
    new Set(
      state.rawJobs
        .map((job) => normalizeOptionalStringifiedId(job.id))
        .filter((id): id is string => id !== undefined),
    ),
  );
  if (quarantineRecovery.recoveredJobs.length > 0) {
    state.rawJobs.push(...quarantineRecovery.recoveredJobs);
  }
  const runtimePolicyPlan =
    params.migrateCodexModelRefs === true
      ? planCronCodexRefRewriteAgainstPersistedConfig({
          cfg: params.cfg,
          targets: collectStoredCronCodexRuntimePolicyTargets(state.rawJobs),
          blockedModelIdentities: params.blockedModelIdentities,
          resolveFinalModelRef: resolveRetired,
        })
      : undefined;
  warnings.push(...(runtimePolicyPlan?.warnings ?? []));
  const blockedRuntimePolicyTargets = new Set(
    (runtimePolicyPlan?.blockedTargets ?? []).map(cronCodexRuntimePolicyTargetKey),
  );
  const normalized =
    params.normalized && quarantineRecovery.recoveredJobs.length === 0
      ? params.normalized
      : normalizeStoredCronJobs(state.rawJobs, {
          migrateCodexModelRefs: params.migrateCodexModelRefs,
          shouldMigrateCodexRuntimePolicyTarget: (target) =>
            !blockedRuntimePolicyTargets.has(cronCodexRuntimePolicyTargetKey(target)),
        });
  warnings.push(
    ...normalized.unsupportedLegacyTriggerScriptJobs.map(
      (job) =>
        `Cron trigger script for ${job} uses legacy Code Mode APIs that cannot be safely converted; inspect the automation and update its trigger script manually to use direct tool calls.`,
    ),
  );
  warnings.push(
    ...normalized.unsupportedDeliveryModeJobs.map(
      (job) =>
        `Cron job ${job} has an unsupported delivery mode. Review its intended delivery and set mode to "none", "announce", or "webhook"; Doctor cannot infer the intended route.`,
    ),
  );
  const legacyWebhook = normalizeOptionalString(asOptionalRecord(params.cfg.cron)?.webhook);
  const notifyMigration = migrateLegacyNotifyFallback({
    jobs: state.rawJobs.filter((job) => canRepairCronDeliveryForDoctor(job.delivery)),
    legacyWebhook,
  });
  warnings.push(...notifyMigration.warnings);
  const retirementChanges: string[] = [];
  if (resolveRetired) {
    for (const job of state.rawJobs) {
      if (!canRepairCronDeliveryForDoctor(job.delivery)) {
        continue;
      }
      const payload = asOptionalRecord(job.payload);
      const jobId = normalizeOptionalStringifiedId(job.id);
      if (!payload || !jobId) {
        continue;
      }
      const projectedOwner = state.projectedOwnersByJobId.get(jobId);
      const agentId =
        normalizeOptionalString(job.agentId) ??
        (projectedOwner && projectedOwner.kind !== "unresolved"
          ? projectedOwner.agentId
          : tryResolveAmbientOwnerAgentId(params.cfg));
      if (!agentId && params.repairRetiredModelRefs) {
        warnings.push(
          `Skipped retired model repair for cron job "${jobId}": select its owning agent, then rerun openclaw doctor --fix.`,
        );
      }
      const beforeChanges = retirementChanges.length;
      repairRetiredModelSlots({
        owner: payload,
        path: `cron.${jobId}.payload`,
        agentId,
        authProfileOnly: !agentId,
        resolve: resolveRetired,
        changes: retirementChanges,
      });
      if (retirementChanges.length > beforeChanges && asOptionalRecord(job.state)?.autoDisabled) {
        const jobName = normalizeOptionalString(job.name) ?? jobId;
        retirementChanges.push(
          `Automation "${jobName}" remains auto-disabled. Run openclaw automations enable ${jobId} to resume it after this repair.`,
        );
      }
    }
  }

  const storeChanged =
    (state.legacyImport?.count ?? 0) > 0 ||
    retirementChanges.length > 0 ||
    state.invalidConfigRows.length > 0 ||
    normalized.mutated ||
    notifyMigration.changed ||
    quarantineRecovery.recoveredJobs.length > 0;
  const changed = state.legacyQuarantine !== undefined || storeChanged;
  return {
    changes,
    warnings,
    normalized,
    quarantineRecovery,
    persistedQuarantineEntrySet,
    retirementChanges,
    storeChanged,
    changed,
  };
}

/** Whether `applyLegacyCronStoreRepair` would write, decided from a read-only state. */
export async function hasLegacyCronStoreRepairWork(
  params: LegacyCronStoreRepairParams,
): Promise<boolean> {
  return (await planLegacyCronStoreRepair(params)).changed;
}
