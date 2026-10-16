// Doctor cron storage repair mechanics for quarantine, payloads, and Codex refs.

import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import { tryResolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  assertCronJobsStoreUnchanged,
  CronJobsStoreChangedError,
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  loadCronQuarantinedJobs,
  resolveCronJobsStorePath,
  saveCronJobsStore,
  saveCronJobsStoreChanges,
  saveCronQuarantinedJobs,
  type CronQuarantinedJob,
  type QuarantinedCronConfigJob,
} from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { fingerprintCronJobRows } from "../../../cron/store/row-codec.js";
import type { CronJob } from "../../../cron/types.js";
import {
  collectErrorGraphCandidates,
  formatErrorMessage as errorMessage,
} from "../../../infra/errors.js";
import type { EngineConnection } from "../../../infra/sql-connection.js";
import { importRetiredStateSource } from "../../../infra/state-migrations.retired-archive.js";
import { listRetiredCronStateFiles } from "../../../infra/state-migrations.retired-cron-files.js";
import { listExistingRetiredStateFiles } from "../../../infra/state-migrations.retired-files.js";
import { backupLegacyStateSource } from "../../../infra/state-migrations.source-backup.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { captureOpenClawStateReadContext } from "../../../state/openclaw-state-worker-context.js";
import { shortenHomePath } from "../../../utils.js";
import { countLabel as pluralize } from "../../doctor-state-integrity-format.js";
import type { LegacyCodexModelIdentity } from "../shared/codex-route-model-ref.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredModelSlots,
  repairModelRefAuthProfile,
} from "../shared/retired-model-ref-repair.js";
import { parseLegacyCronJobs } from "./legacy-json-shapes.js";
import { migrateLegacyNotifyFallback } from "./legacy-notify.js";
import {
  loadLegacyCronQuarantineForMigration,
  type LegacyCronQuarantine,
} from "./legacy-quarantine-migration.js";
import { archiveLegacyCronFile } from "./quarantine-archive.js";
import { mergeRuntimeEntryIntoConfigJob } from "./repair-plan.js";
import { planCronCodexRefRewriteAgainstPersistedConfig } from "./runtime-policy-migration.js";
import {
  assertCronStateSchemaSupported,
  assertCronStateSchemaSupportedAsync,
  rethrowSqliteSchemaVersionError,
} from "./schema-safety.js";
import { inspectCronOwnerRowsForDoctor } from "./store-inventory.js";
import {
  canRepairCronDeliveryForDoctor,
  collectStoredCronCodexRuntimePolicyTargets,
  cronCodexRuntimePolicyTargetKey,
  normalizeStoredCronJobs,
  recoverValidQuarantinedCronScheduleJobs,
  type CronCodexRuntimePolicyTarget,
} from "./store-migration.js";
import { backupCronStoreForDoctor, inspectCronJobOwnersForDoctor } from "./store-repair.js";

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

export type LegacyCronRepairResult = {
  changes: string[];
  warnings: string[];
  codexRuntimePolicyTargets?: CronCodexRuntimePolicyTarget[];
};

export function readLegacyCronStorePath(cfg: OpenClawConfig): string | undefined {
  return (cfg.cron as (NonNullable<OpenClawConfig["cron"]> & { store?: string }) | undefined)
    ?.store;
}

function projectCronOwner(
  job: { agentId?: unknown; sessionKey?: unknown },
  runtimeDefaultAgentId: string | undefined,
): CronOwnerProjection {
  const explicitAgentId =
    normalizeOptionalString(job.agentId) ??
    parseAgentSessionKey(normalizeOptionalString(job.sessionKey))?.agentId;
  if (explicitAgentId) {
    return { kind: "explicit", agentId: explicitAgentId };
  }
  return runtimeDefaultAgentId
    ? { kind: "runtime-default", agentId: runtimeDefaultAgentId }
    : { kind: "unresolved" };
}

export async function loadLegacyCronRepairState(params: {
  cfg: OpenClawConfig;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  onlyIfLegacyDetected?: boolean;
  readOnly?: boolean;
}): Promise<LegacyCronRepairState | null> {
  const storePath =
    params.storePath ?? resolveCronJobsStorePath(readLegacyCronStorePath(params.cfg), params.env);
  await assertCronStateSchemaSupportedAsync(params.env);
  const legacyQuarantine = await loadLegacyCronQuarantineForMigration(storePath);
  if (params.onlyIfLegacyDetected && !legacyQuarantine) {
    return null;
  }
  const persistedQuarantine = await loadCronQuarantinedJobs(storePath, params.env);

  const loaded = params.readOnly
    ? await loadCronJobsStoreWithConfigJobsReadOnly(storePath, params.env)
    : await loadCronJobsStoreWithConfigJobs(storePath);
  const runtimeDefaultAgentId = tryResolveAmbientOwnerAgentId(params.cfg);
  const projectedOwnersByJobId = new Map(
    loaded.store.jobs.map((job) => [job.id, projectCronOwner(job, runtimeDefaultAgentId)]),
  );
  const ownerRows = await inspectCronJobOwnersForDoctor(
    { env: params.env ?? process.env },
    storePath,
  );
  if (
    loaded.jobsFingerprint !== undefined &&
    fingerprintCronJobRows(ownerRows) !== loaded.jobsFingerprint
  ) {
    throw new CronJobsStoreChangedError(storePath);
  }
  const sqlOwners = new Map(
    ownerRows.flatMap((row) => {
      const agentId = normalizeOptionalString(row.agent_id);
      return agentId ? [[row.job_id, agentId] as const] : [];
    }),
  );
  for (const [jobId, agentId] of sqlOwners) {
    if (projectedOwnersByJobId.get(jobId)?.kind !== "explicit") {
      projectedOwnersByJobId.set(jobId, { kind: "explicit", agentId });
    }
  }
  const invalidConfigRows: QuarantinedCronConfigJob[] = [...loaded.invalidConfigRows];
  const currentJobs =
    loaded.configJobs.length > 0
      ? loaded.configJobs.map((job, index) =>
          mergeRuntimeEntryIntoConfigJob({
            job,
            runtimeEntry: loaded.configJobRuntimeEntries[index],
          }),
        )
      : (loaded.store.jobs as unknown as Array<Record<string, unknown>>);
  for (const job of currentJobs) {
    const jobId = normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
    const sqlOwner = jobId ? sqlOwners.get(jobId) : undefined;
    if (
      sqlOwner &&
      canRepairCronDeliveryForDoctor(job.delivery) &&
      projectCronOwner(job, undefined).kind === "unresolved"
    ) {
      job.agentId = sqlOwner;
    }
  }
  return {
    storePath,
    legacyQuarantine,
    invalidConfigRows,
    persistedQuarantine,
    projectedOwnersByJobId,
    rawJobs: currentJobs,
    jobsFingerprint: loaded.jobsFingerprint,
    ownerRows,
  };
}

export async function applyLegacyCronStoreRepair(params: {
  cfg: OpenClawConfig;
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  authProfileIdMap?: ReadonlyMap<string, string>;
  state: LegacyCronRepairState;
  normalized?: ReturnType<typeof normalizeStoredCronJobs>;
  migrateCodexModelRefs?: boolean;
  repairRetiredModelRefs?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  recoverQuarantinedScheduleJobs?: boolean;
}): Promise<LegacyCronRepairResult> {
  assertCronStateSchemaSupported();
  const { state } = params;
  const changes: string[] = [];
  const warnings: string[] = [];
  // Earlier legacy migrations do not authorize retiring current model choices.
  const resolveRetired =
    params.repairRetiredModelRefs === true
      ? createRetiredModelRefRepairResolver({
          cfg: params.cfg,
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
  const legacyWebhook = normalizeOptionalString(
    (params.cfg.cron as Record<string, unknown> | undefined)?.webhook,
  );
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
  if (!changed && warnings.length === 0) {
    return { changes, warnings };
  }

  const quarantineEntries: (QuarantinedCronConfigJob | CronQuarantinedJob)[] = [
    ...(params.recoverQuarantinedScheduleJobs === true
      ? quarantineRecovery.retainedEntries.filter(
          (entry) => !persistedQuarantineEntrySet.has(entry),
        )
      : (state.legacyQuarantine?.jobs ?? [])),
    ...state.invalidConfigRows,
    ...normalized.removedJobs.map((entry) => ({
      sourceIndex: entry.sourceIndex,
      reason: entry.reason,
      job: entry.job,
    })),
  ];
  const quarantine =
    quarantineEntries.length > 0 ? { entries: quarantineEntries, nowMs: Date.now() } : undefined;
  const deleteQuarantineEntries = quarantineRecovery.recoveredEntries.filter((entry) =>
    persistedQuarantineEntrySet.has(entry),
  );

  if (storeChanged || quarantine) {
    try {
      if (storeChanged) {
        const store = {
          version: 1,
          jobs: state.rawJobs as unknown as CronJob[],
        } as const;
        const source = captureOpenClawStateReadContext();
        const assertCurrent = () => {
          source.admission.assertCurrent();
          source.maintenanceScope?.assertDatabaseAccess(source.admission.databasePath);
        };
        const assertSnapshotCurrent = (db: EngineConnection): undefined => {
          assertCurrent();
          state.legacyImport?.assertCurrent();
          if (
            !isDeepStrictEqual(
              inspectCronOwnerRowsForDoctor(db, cronStoreKey(state.storePath)),
              state.ownerRows,
            )
          ) {
            throw new CronJobsStoreChangedError(state.storePath);
          }
          if (state.jobsFingerprint !== undefined) {
            assertCronJobsStoreUnchanged(db, state.storePath, state.jobsFingerprint);
          }
        };
        const saveOptions = {
          ...(quarantine ? { quarantine } : {}),
          ...(deleteQuarantineEntries.length > 0 ? { deleteQuarantineEntries } : {}),
          preserveRuntimeState: true,
        };
        if (state.ownerRows.length > 0 || state.persistedQuarantine.length > 0) {
          const backupPath = await backupCronStoreForDoctor(
            { env: process.env },
            { assertCurrent, assertRowsUnchanged: assertSnapshotCurrent },
          );
          changes.push(`Saved pre-repair cron backup: ${backupPath}`);
        }
        await saveCronJobsStore(state.storePath, store, {
          ...saveOptions,
          transactionHooks: { beforeWrite: assertSnapshotCurrent },
        });
      } else if (quarantine) {
        await saveCronQuarantinedJobs({ storePath: state.storePath, ...quarantine });
      }
    } catch (err) {
      rethrowSqliteSchemaVersionError(err);
      if (state.legacyImport) {
        throw err;
      }
      const snapshotChanged = collectErrorGraphCandidates(err, (current) => [current.cause]).some(
        (cause) => cause instanceof CronJobsStoreChangedError,
      );
      const failure = snapshotChanged
        ? `Cron store at ${shortenHomePath(state.storePath)} changed while doctor was waiting, so no rows were rewritten; re-run ${formatCliCommand("openclaw doctor --fix")} to repair from a fresh snapshot.`
        : `Failed writing migrated cron store at ${shortenHomePath(state.storePath)}: ${errorMessage(err)}`;
      return { changes, warnings: [...warnings, failure] };
    }
  }

  changes.push(...retirementChanges);
  if (normalized.issues.reconciledOwnerAccount) {
    changes.push(
      `Reconciled ${pluralize(normalized.issues.reconciledOwnerAccount, "cron job owner account")} from persisted creator identity; existing tool permissions were preserved.`,
    );
  }
  if (quarantineRecovery.recoveredJobs.length > 0) {
    changes.push(
      `Recovered ${pluralize(quarantineRecovery.recoveredJobs.length, "quarantined automation")} after current schedule validation passed.`,
    );
  }

  if (state.legacyQuarantine) {
    const archiveResult = await archiveLegacyCronFile(
      state.legacyQuarantine.path,
      state.legacyQuarantine.sourceSha256,
    );
    if (archiveResult.ok) {
      changes.push(
        `Cron quarantine migrated to SQLite from ${shortenHomePath(state.legacyQuarantine.path)}.`,
      );
    } else {
      warnings.push(
        archiveResult.deferred
          ? archiveResult.reason
          : `Migrated quarantined automations to SQLite but could not archive the legacy cron file at ${shortenHomePath(state.legacyQuarantine.path)}: ${archiveResult.reason}. Remove it manually or rerun ${formatCliCommand("openclaw doctor --fix")} to retry.`,
      );
    }
  }

  if (storeChanged) {
    changes.push(`Cron store normalized at ${shortenHomePath(state.storePath)}.`);
  }
  if (normalized.legacyTriggerScriptJobs.length > 0) {
    changes.push(
      `Rewrote ${pluralize(normalized.legacyTriggerScriptJobs.length, "legacy cron trigger script")} to direct tool calls: ${normalized.legacyTriggerScriptJobs.join(", ")}.`,
    );
  }

  return {
    changes,
    warnings,
    codexRuntimePolicyTargets: normalized.codexRuntimePolicyTargets,
  };
}

export async function repairLegacyCronStoreWithoutPrompt(params: {
  cfg: OpenClawConfig;
  migrateCodexModelRefs?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): Promise<LegacyCronRepairResult> {
  const imported = await migrateRetiredCronState(params);
  const storePath = resolveCronJobsStorePath(
    normalizeOptionalString(readLegacyCronStorePath(params.cfg)),
  );
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({
      cfg: params.cfg,
      onlyIfLegacyDetected: true,
    });
  } catch (err) {
    rethrowSqliteSchemaVersionError(err);
    return {
      changes: [],
      warnings: [
        `Failed reading legacy cron storage at ${shortenHomePath(storePath)}: ${errorMessage(err)}`,
      ],
    };
  }
  if (!state) {
    return imported;
  }
  const repaired = await applyLegacyCronStoreRepair({ ...params, state });
  return {
    ...repaired,
    changes: [...imported.changes, ...repaired.changes],
    warnings: [...imported.warnings, ...repaired.warnings],
  };
}

/** One-shot Doctor import; runtime continues to consume only canonical SQLite rows. */
export async function migrateRetiredCronState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyCronRepairResult> {
  const env = params.env ?? process.env;
  await assertCronStateSchemaSupportedAsync(env);
  const storePath = resolveCronJobsStorePath(readLegacyCronStorePath(params.cfg), env);
  const candidates = await listRetiredCronStateFiles(storePath);
  const statePath = candidates[1]!;
  const source = captureOpenClawStateReadContext();
  const assertCurrent = () => {
    source.admission.assertCurrent();
    source.maintenanceScope?.assertDatabaseAccess(source.admission.databasePath);
  };
  const backups = new Map<string, Awaited<ReturnType<typeof backupLegacyStateSource>>>();
  for (const filePath of listExistingRetiredStateFiles(candidates)) {
    backups.set(filePath, await backupLegacyStateSource({ filePath, assertCurrent }));
  }
  const result: LegacyCronRepairResult = { changes: [], warnings: [] };
  const jobsSource = backups.get(storePath);
  if (jobsSource) {
    await importRetiredStateSource({
      source: jobsSource,
      label: "legacy cron jobs",
      parse: (bytes) => parseLegacyCronJobs(bytes, backups.get(statePath)?.bytes),
      recoveryInstructions: `Recover job definitions from ${jobsSource.backupPath} with openclaw automations add.`,
      result,
      commit: async (legacy) => {
        result.warnings.push(...legacy.warnings);
        const state = await loadLegacyCronRepairState({ cfg: params.cfg, storePath, env });
        if (!state) {
          throw new Error("Cron repair snapshot unavailable");
        }
        const ids = new Set(state.rawJobs.map((job) => normalizeOptionalStringifiedId(job.id)));
        const imported = legacy.jobs.filter((job) => {
          const id = normalizeOptionalStringifiedId(job.id);
          if (ids.has(id)) {
            return false;
          }
          ids.add(id);
          return true;
        });
        if (imported.length) {
          state.rawJobs.push(...imported);
          state.legacyImport = {
            count: imported.length,
            assertCurrent: () => {
              jobsSource.assertUnchanged();
              backups.get(statePath)?.assertUnchanged();
            },
          };
          const repaired = await applyLegacyCronStoreRepair({ cfg: params.cfg, state });
          result.changes.push(...repaired.changes);
          result.warnings.push(...repaired.warnings);
          result.changes.push(`Imported ${imported.length} legacy cron job(s) into SQLite.`);
        }
      },
    });
  }
  for (const [filePath, backup] of backups) {
    if (filePath === storePath) {
      continue;
    }
    assertCurrent();
    backup.removeSource(() => undefined);
    result.warnings.push(
      `Archived retired cron state to ${backup.backupPath}. ${filePath.endsWith(".jsonl") ? "Historical runs remain readable as JSONL in this archive; current runs use SQLite task history." : "Original job definitions and runtime state remain available in this archive."}`,
    );
  }
  return result;
}

/** Read legacy Codex cron targets without changing either cron storage or config. */
export async function collectCronCodexRuntimePolicyTargetsReadOnly(params: {
  cfg: OpenClawConfig;
}): Promise<{ targets: CronCodexRuntimePolicyTarget[]; warnings: string[] }> {
  const storePath = resolveCronJobsStorePath(
    normalizeOptionalString(readLegacyCronStorePath(params.cfg)),
  );
  try {
    const state = await loadLegacyCronRepairState({ cfg: params.cfg, readOnly: true });
    return {
      targets: state ? collectStoredCronCodexRuntimePolicyTargets(state.rawJobs) : [],
      warnings: [],
    };
  } catch (err) {
    rethrowSqliteSchemaVersionError(err);
    return {
      targets: [],
      warnings: [
        `Failed reading cron storage at ${shortenHomePath(storePath)} while planning Codex model migration: ${errorMessage(err)}`,
      ],
    };
  }
}

/** Commit Codex cron refs only after their model-scoped config policy is durable. */
export async function repairCronCodexModelRefsAfterConfigWrite(params: {
  cfg: OpenClawConfig;
  migrateCodexModelRefs: boolean;
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  authProfileIdMap?: ReadonlyMap<string, string>;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  repairRetiredModelRefs?: boolean;
}): Promise<LegacyCronRepairResult> {
  const storePath = resolveCronJobsStorePath(
    normalizeOptionalString(readLegacyCronStorePath(params.cfg)),
  );
  try {
    if (!params.migrateCodexModelRefs && !params.repairRetiredModelRefs) {
      const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
      const { store } = loaded;
      const repaired = structuredClone(store);
      const changes: string[] = [];
      for (const [index, job] of repaired.jobs.entries()) {
        const {
          runtimeAuthority: _embeddedAuthority,
          runtimeAuthorityRecoveryRequired: _embeddedRecovery,
          ...config
        } = loaded.configJobs[index]!;
        const candidate = Object.assign(
          structuredClone(job),
          mergeRuntimeEntryIntoConfigJob({
            job: structuredClone(config),
            runtimeEntry: loaded.configJobRuntimeEntries[index],
          }),
        );
        const before = changes.length;
        repairRetiredModelSlots({
          owner: candidate.payload,
          path: `cron.${job.id}.payload`,
          authProfileOnly: true,
          resolve: ({ modelRef }) => repairModelRefAuthProfile(modelRef, params.authProfileIdMap),
          changes,
        });
        if (changes.length > before) {
          repaired.jobs[index] = candidate;
        }
      }
      await saveCronJobsStoreChanges(storePath, store, repaired);
      return { changes, warnings: [] };
    }
    const state = await loadLegacyCronRepairState({ cfg: params.cfg });
    return state
      ? await applyLegacyCronStoreRepair({ ...params, state })
      : { changes: [], warnings: [] };
  } catch (err) {
    rethrowSqliteSchemaVersionError(err);
    return {
      changes: [],
      warnings: [
        `Failed reading cron storage at ${shortenHomePath(storePath)} while committing Codex model migration: ${errorMessage(err)}`,
      ],
    };
  }
}
