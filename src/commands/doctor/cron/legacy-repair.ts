// Doctor cron storage repair mechanics for quarantine, payloads, and Codex refs.

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import { tryResolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
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
import { fingerprintCronJobRows } from "../../../cron/store/row-codec.js";
import type { CronJob } from "../../../cron/types.js";
import {
  collectErrorGraphCandidates,
  formatErrorMessage as errorMessage,
} from "../../../infra/errors.js";
import { importRetiredStateSource } from "../../../infra/state-migrations.retired-archive.js";
import { listRetiredCronStateFiles } from "../../../infra/state-migrations.retired-cron-files.js";
import { listExistingRetiredStateFiles } from "../../../infra/state-migrations.retired-files.js";
import { backupLegacyStateSource } from "../../../infra/state-migrations.source-backup.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { captureOpenClawStateReadContext } from "../../../state/openclaw-state-worker-context.js";
import { shortenHomePath } from "../../../utils.js";
import { countLabel as pluralize } from "../../doctor-state-integrity-format.js";
import type { LegacyCodexModelIdentity } from "../shared/codex-route-model-ref.js";
import { rewriteModelReferenceSlot } from "../shared/codex-route-model-slots.js";
import { createModelAliasCanonicalizer } from "../shared/model-alias-canonicalization.js";
import {
  repairRetiredModelSlots,
  repairModelRefAuthProfile,
} from "../shared/retired-model-ref-repair.js";
import { readCronStoreSelectionForDoctor } from "./default-store-selection.js";
import { parseLegacyCronJobs } from "./legacy-json-shapes.js";
import { loadLegacyCronQuarantineForMigration } from "./legacy-quarantine-migration.js";
import { captureLegacyCronRepairAdmission } from "./legacy-repair-admission.js";
import {
  hasLegacyCronStoreRepairWork,
  planLegacyCronStoreRepair,
  type CronOwnerProjection,
  type LegacyCronRepairState,
  type LegacyCronStoreRepairParams,
} from "./legacy-repair-plan.js";
import { archiveLegacyCronFile } from "./quarantine-archive.js";
import { mergeRuntimeEntryIntoConfigJob } from "./repair-plan.js";
import {
  assertCronStateSchemaSupportedAsync,
  rethrowSqliteSchemaVersionError,
} from "./schema-safety.js";
import {
  canRepairCronDeliveryForDoctor,
  collectStoredCronCodexRuntimePolicyTargets,
  type CronCodexRuntimePolicyTarget,
} from "./store-migration.js";
import { backupCronStoreForDoctor, inspectCronJobOwnersForDoctor } from "./store-repair.js";

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

export async function applyLegacyCronStoreRepair(
  params: LegacyCronStoreRepairParams,
): Promise<LegacyCronRepairResult> {
  const { state } = params;
  const {
    changes,
    warnings,
    normalized,
    quarantineRecovery,
    persistedQuarantineEntrySet,
    retirementChanges,
    storeChanged,
    changed,
  } = await planLegacyCronStoreRepair(params);
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
        const { assertCurrent, assertRowsUnchanged: assertSnapshotCurrent } =
          captureLegacyCronRepairAdmission(state);
        const saveOptions = {
          ...(quarantine ? { quarantine } : {}),
          ...(deleteQuarantineEntries.length > 0 ? { deleteQuarantineEntries } : {}),
          preserveRuntimeState: true,
        };
        if (state.ownerRows.length > 0 || state.persistedQuarantine.length > 0) {
          const backup = await backupCronStoreForDoctor(
            { env: process.env },
            {
              plan: [
                "legacy",
                state.storePath,
                state.ownerRows,
                state.jobsFingerprint,
                state.persistedQuarantine,
                store,
                quarantineEntries,
                deleteQuarantineEntries,
              ],
              assertCurrent,
              assertRowsUnchanged: assertSnapshotCurrent,
            },
          );
          if (backup.backupPath) {
            changes.push(`Saved pre-repair cron backup: ${backup.backupPath}`);
          }
          warnings.push(...backup.warnings);
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
  const selection = await readCronStoreSelectionForDoctor(params.cfg);
  if (selection.status === "unresolved") {
    return { changes: [], warnings: [selection.message] };
  }
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
type CronCodexModelRefsAfterConfigWriteParams = {
  cfg: OpenClawConfig;
  migrateCodexModelRefs: boolean;
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  modelReplacements?: readonly import("../shared/model-replacement.js").DoctorModelReplacement[];
  authProfileIdMap?: ReadonlyMap<string, string>;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  repairRetiredModelRefs?: boolean;
};

/** Read-only: whether `repairCronCodexModelRefsAfterConfigWrite` would rewrite cron rows. */
export async function hasCronCodexModelRefsAfterConfigWriteWork(
  params: CronCodexModelRefsAfterConfigWriteParams,
): Promise<boolean> {
  if (!params.migrateCodexModelRefs && !params.repairRetiredModelRefs) {
    // The auth-profile-only rewrite is cheap and rare; any remapping counts as work.
    return Boolean(params.authProfileIdMap?.size);
  }
  const state = await loadLegacyCronRepairState({ cfg: params.cfg, readOnly: true });
  return state ? await hasLegacyCronStoreRepairWork({ ...params, state }) : false;
}

export async function repairCronCodexModelRefsAfterConfigWrite(
  params: CronCodexModelRefsAfterConfigWriteParams,
): Promise<LegacyCronRepairResult> {
  const storePath = resolveCronJobsStorePath(
    normalizeOptionalString(readLegacyCronStorePath(params.cfg)),
  );
  try {
    if (!params.migrateCodexModelRefs && !params.repairRetiredModelRefs) {
      const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
      const { store } = loaded;
      const repaired = { ...store, jobs: [...store.jobs] };
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

/** Freeze old alias identities before config retargeting, using the optimistic cron writer. */
export async function canonicalizeCronModelReplacementAliases(params: {
  cfg: OpenClawConfig;
  modelReplacements: readonly import("../shared/model-replacement.js").DoctorModelReplacement[];
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyCronRepairResult> {
  const selection = await readCronStoreSelectionForDoctor(params.cfg, params.env ?? process.env);
  if (selection.status !== "ready") {
    return {
      changes: [],
      warnings: ["Cannot prepare model aliases until the cron partition is selected."],
    };
  }
  const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(selection.storePath);
  const original = loaded.store;
  const repaired = { ...original, jobs: [...original.jobs] };
  const canonicalize = createModelAliasCanonicalizer(params.cfg, params.modelReplacements);
  const changes: string[] = [];
  for (const [index, job] of original.jobs.entries()) {
    const {
      runtimeAuthority: _authority,
      runtimeAuthorityRecoveryRequired: _recovery,
      ...config
    } = loaded.configJobs[index]!;
    const candidate = Object.assign(
      structuredClone(job),
      mergeRuntimeEntryIntoConfigJob({
        job: structuredClone(config),
        runtimeEntry: loaded.configJobRuntimeEntries[index],
      }),
    );
    const agentId =
      candidate.agentId ??
      parseAgentSessionKey(candidate.sessionKey)?.agentId ??
      tryResolveAmbientOwnerAgentId(params.cfg);
    if (!agentId) {
      continue;
    }
    const rewrite = (raw: string) => canonicalize(raw, agentId);
    const payload = asOptionalRecord(candidate.payload);
    const before = JSON.stringify(payload);
    rewriteModelReferenceSlot({
      container: payload,
      key: "model",
      path: "model",
      resolve: rewrite,
    });
    rewriteModelReferenceSlot({
      container: { selector: payload },
      key: "selector",
      path: "payload",
      resolve: rewrite,
    });
    if (JSON.stringify(payload) !== before) {
      repaired.jobs[index] = candidate;
      changes.push(
        'Preserved old model alias identity for cron job "' + job.id + '" before config migration.',
      );
    }
  }
  await saveCronJobsStoreChanges(selection.storePath, original, repaired);
  return { changes, warnings: [] };
}
