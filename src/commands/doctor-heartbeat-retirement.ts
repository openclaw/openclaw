import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.js";
import { cloneCronJobForMutation, finalizeUpdatedJob } from "../cron/service/jobs-mutation.js";
import { publishCronJobsStoreMutation, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, upsertCronJobRow } from "../cron/store/row-codec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  collectHeartbeatCadenceMigrationFindings,
  ensureHeartbeatMonitorJobs,
} from "./doctor-heartbeat-cadence-migration.js";
import { decodeDoctorHeartbeatJobRows } from "./doctor-heartbeat-jobs.js";
import {
  migrateHeartbeatPrompt,
  projectRetiredHeartbeatConfig,
  resolveLegacyHeartbeatConfig,
  resolveLegacyHeartbeatIntervalMs,
  validateLegacyHeartbeatConfig,
} from "./doctor-heartbeat-legacy.js";
import { resolveHeartbeatAutomationModel } from "./doctor-heartbeat-model.js";
import { resolveDoctorHeartbeatReceiptJob } from "./doctor-heartbeat-monitors.js";
import { migrateHeartbeatOutcomes } from "./doctor-heartbeat-outcome-migration.js";
import {
  collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch,
} from "./doctor-heartbeat-scratch-migration.js";
import {
  isHeartbeatTaskCronJob,
  resolveHeartbeatTaskPromptRepair,
} from "./doctor-heartbeat-task-identity.js";
import {
  maybeMigrateHeartbeatTasksToCron,
  migrateStoredHeartbeatTaskJobs,
} from "./doctor-heartbeat-task-migration.js";
import { sanitizeDoctorNote } from "./doctor/emit-notes.js";
import { migrateHeartbeatVisibility } from "./doctor/shared/channel-legacy-config-migrate.js";

/** Data commits first. Unsafe input prevents config removal and remains retryable. */
export async function retireHeartbeatWithDoctor(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  onWarnings?: (warnings: readonly string[]) => void,
) {
  const cfg = inheritLegacyDefaultAgentId(sourceConfig, structuredClone(sourceConfig));
  migrateHeartbeatVisibility(cfg, []);
  validateLegacyHeartbeatConfig(cfg);
  const heartbeatSources = new Map(
    listAgentIds(cfg).map((agentId) => [agentId, resolveLegacyHeartbeatConfig(cfg, agentId)]),
  );
  const next = projectRetiredHeartbeatConfig(cfg);
  const [cadenceFindings, scratchFindings] = await Promise.all([
    collectHeartbeatCadenceMigrationFindings(cfg, env),
    collectHeartbeatScratchMigrationFindings(cfg, env),
  ]);
  if (isDeepStrictEqual(next, cfg) && !cadenceFindings.length && !scratchFindings.length) {
    await migrateHeartbeatOutcomes(cfg, env);
    return next;
  }
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const monitors = await ensureHeartbeatMonitorJobs(
    cfg,
    storePath,
    env,
    scratchFindings.flatMap((finding) => (finding.target ? [finding.target] : [])),
  );
  const scratch = await maybeMigrateHeartbeatFilesToScratch({ cfg, env, shouldRepair: true });
  if (scratch.warnings.length) {
    throw new Error(scratch.warnings.join("\n"));
  }
  const tasks = await maybeMigrateHeartbeatTasksToCron({ cfg, env, shouldRepair: true });
  if (tasks.warnings.length) {
    throw new Error(tasks.warnings.join("\n"));
  }
  await migrateStoredHeartbeatTaskJobs(cfg, env);
  await migrateHeartbeatOutcomes(cfg, env);
  const modelFallbacks = new Map(
    listAgentIds(cfg).map((agentId) => [
      agentId,
      resolveHeartbeatAutomationModel(cfg, agentId).fallback,
    ]),
  );
  const {
    completedCutover,
    repairedPrompts: repairedTaskPrompts,
    modelWarnings,
    recoveryWarnings: cutoverWarnings,
  } = runOpenClawStateWriteTransaction(
    ({ db }) => {
      let completed = false;
      let repairedPrompts = 0;
      const warnings: string[] = [];
      const recoveryWarnings: string[] = [];
      const rows = loadCronRows(db, cronStoreKey(storePath));
      const jobs = decodeDoctorHeartbeatJobRows(rows);
      if (jobs.some((job) => job.payload.kind === "heartbeat" || isHeartbeatTaskCronJob(job))) {
        throw new Error(
          "Legacy automation rows changed during cutover; config was retained. Stop the Gateway and rerun Doctor.",
        );
      }
      for (const agentId of new Set([...listAgentIds(cfg), ...monitors.keys()])) {
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
        for (const job of jobs) {
          const row = rows.find((candidate) => candidate.job_id === job.id)!;
          const message =
            job.agentId === agentId
              ? resolveHeartbeatTaskPromptRepair(job, receipt, row.updated_at)
              : undefined;
          if (message === undefined || job.payload.kind !== "agentTurn") {
            continue;
          }
          const nextJob = cloneCronJobForMutation({ ...job, payload: job.payload });
          nextJob.payload = { ...job.payload, message };
          nextJob.updatedAtMs = Date.now();
          upsertCronJobRow(db, cronStoreKey(storePath), nextJob, row.sort_order, {
            preserveRuntimeState: true,
          });
          repairedPrompts += 1;
        }
        if (!receipt || receipt.phase === "complete") {
          continue;
        }
        const job = resolveDoctorHeartbeatReceiptJob(cfg, jobs, agentId, receipt, undefined);
        if (!job) {
          throw new Error(
            `Automation ${receipt.jobId} was deleted during cutover; legacy configuration was retained.`,
          );
        }
        const heartbeat = heartbeatSources.get(agentId);
        const disabled =
          receipt.heartbeatEnabled === false ||
          (heartbeat?.every !== undefined &&
            resolveLegacyHeartbeatIntervalMs(cfg, undefined, heartbeat) === null);
        if (job.enabled && disabled) {
          const nextJob = cloneCronJobForMutation(job);
          nextJob.enabled = false;
          finalizeUpdatedJob({
            job,
            nextJob,
            now: Date.now(),
            schedulingInputsRequested: true,
            scheduleChanged: false,
          });
          upsertCronJobRow(
            db,
            cronStoreKey(storePath),
            nextJob,
            rows.find((row) => row.job_id === job.id)!.sort_order,
          );
        } else if (job.enabled && !heartbeat && receipt.heartbeatEnabled === undefined) {
          recoveryWarnings.push(
            `Agent "${agentId}" automation "${job.id}" has an incomplete heartbeat migration without its original enabled setting. If the heartbeat was disabled, run "openclaw automations disable ${job.id}", then "openclaw doctor --fix". Otherwise enable it after disabling and completing Doctor. Its pending receipt and job were preserved.`,
          );
          continue;
        }
        const fallback = modelFallbacks.get(agentId);
        if (fallback) {
          const migratedIds = new Set([receipt.jobId, ...(receipt.convertedJobIds ?? [])]);
          for (const migratedJob of jobs) {
            if (
              migratedIds.has(migratedJob.id) &&
              migratedJob.agentId === agentId &&
              migratedJob.payload.kind === "agentTurn" &&
              !migratedJob.payload.model
            ) {
              warnings.push(
                sanitizeDoctorNote(
                  `Agent "${agentId}" automation "${migratedJob.id}": dropped heartbeat model "${fallback.model}" because it is outside the agent's allowed model policy. The automation uses normal model selection with configured default "${fallback.defaultModel}". Next step: pick an allowed model or add it to the agent's modelPolicy.allow (agents.entries.${agentId}.modelPolicy.allow) before selecting it.`,
                ),
              );
            }
          }
        }
        recordDefaultProactiveJobInDatabase(db, storePath, agentId, receipt.jobId, Date.now());
        completed = true;
      }
      publishCronJobsStoreMutation(storePath, db);
      return {
        completedCutover: completed,
        repairedPrompts,
        modelWarnings: warnings,
        recoveryWarnings,
      };
    },
    { env },
    { operationLabel: "doctor.heartbeat-cutover-complete" },
  );
  if (cutoverWarnings.length) {
    note(cutoverWarnings.map(sanitizeDoctorNote).join("\n"), "Doctor warnings");
    onWarnings?.(cutoverWarnings);
  }
  if (repairedTaskPrompts) {
    note(
      `Updated migrated heartbeat task quiet replies: ${repairedTaskPrompts}.`,
      "Doctor changes",
    );
  }
  if (completedCutover) {
    note(
      "Migrated heartbeats now use standard Automations delivery. Heartbeat-specific duplicate suppression and no-route skipping were removed: repeated updates can be delivered, and a missing route no longer skips the run before execution. Delivery failures follow ordinary automation handling. Review the migrated jobs' delivery settings if you relied on either behavior.",
      "Heartbeat delivery changed",
    );
  }
  if (modelWarnings.length) {
    note(modelWarnings.join("\n"), "Heartbeat model changed");
    const log = createSubsystemLogger("doctor");
    for (const warning of modelWarnings) {
      log.warn(warning);
    }
  }
  if (
    [...monitors.keys()].some((agentId) => {
      const prompt = resolveLegacyHeartbeatConfig(cfg, agentId)?.prompt;
      return prompt !== undefined && migrateHeartbeatPrompt(prompt) !== prompt;
    })
  ) {
    note(
      "Translated standalone HEARTBEAT_OK acknowledgments in migrated prompts to ordinary NO_REPLY silence.",
      "Doctor changes",
    );
  }
  return next;
}

export async function maybeMigrateHeartbeatCadenceToCron(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const findings = (
    await Promise.all([
      collectHeartbeatCadenceMigrationFindings(params.cfg, params.env),
      collectHeartbeatScratchMigrationFindings(params.cfg, params.env),
    ])
  ).flat();
  if (!params.shouldRepair || !findings.length) {
    return { changes: [], warnings: findings.map((finding) => finding.message) };
  }
  try {
    const warnings: string[] = [];
    await retireHeartbeatWithDoctor(params.cfg, params.env, (reported) =>
      warnings.push(...reported),
    );
    if (warnings.length) {
      return { changes: [], warnings };
    }
    const changes = [
      "Converted legacy heartbeat cadence to ordinary editable automations; recorded one-way provisioning receipts.",
    ];
    note(changes.join("\n"), "Doctor changes");
    return { changes, warnings: [] };
  } catch (error) {
    const warnings = [formatErrorMessage(error)];
    note(warnings.join("\n"), "Doctor warnings");
    return { changes: [], warnings };
  }
}
