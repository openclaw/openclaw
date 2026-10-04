import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  prepareClawHeartbeatMigration,
  finishClawHeartbeatMigration,
} from "../claws/heartbeat-migration.js";
import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.js";
import { publishCronJobsStoreMutation, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows } from "../cron/store/row-codec.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  collectHeartbeatCadenceMigrationFindings,
  ensureHeartbeatMonitorJobs,
} from "./doctor-heartbeat-cadence-migration.js";
import { decodeDoctorHeartbeatJobRows } from "./doctor-heartbeat-jobs.js";
import {
  migrateHeartbeatPrompt,
  projectRetiredHeartbeatConfig,
  resolveHeartbeatConfig,
  validateLegacyHeartbeatConfig,
} from "./doctor-heartbeat-legacy.js";
import { migrateHeartbeatOutcomes } from "./doctor-heartbeat-outcome-migration.js";
import {
  collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch,
} from "./doctor-heartbeat-scratch-migration.js";
import { isHeartbeatTaskCronJob } from "./doctor-heartbeat-task-identity.js";
import {
  maybeMigrateHeartbeatTasksToCron,
  migrateStoredHeartbeatTaskJobs,
} from "./doctor-heartbeat-task-migration.js";
import { migrateHeartbeatVisibility } from "./doctor-heartbeat-visibility.js";

/** Data commits first. Any ambiguous input prevents config removal and remains retryable. */
export async function retireHeartbeatWithDoctor(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  const cfg = inheritLegacyDefaultAgentId(sourceConfig, structuredClone(sourceConfig));
  migrateHeartbeatVisibility(cfg, []);
  validateLegacyHeartbeatConfig(cfg);
  const next = projectRetiredHeartbeatConfig(cfg);
  const [cadenceFindings, scratchFindings] = await Promise.all([
    collectHeartbeatCadenceMigrationFindings(cfg, env),
    collectHeartbeatScratchMigrationFindings(cfg, env),
  ]);
  if (isDeepStrictEqual(next, cfg) && !cadenceFindings.length && !scratchFindings.length) {
    await migrateHeartbeatOutcomes(cfg, env);
    return next;
  }
  const clawHandoff = await prepareClawHeartbeatMigration(cfg, { env });
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
  await finishClawHeartbeatMigration(clawHandoff, next, { env }, monitors);
  const completedCutover = runOpenClawStateWriteTransaction(
    ({ db }) => {
      let completed = false;
      const jobs = decodeDoctorHeartbeatJobRows(loadCronRows(db, cronStoreKey(storePath)));
      if (jobs.some((job) => job.payload.kind === "heartbeat" || isHeartbeatTaskCronJob(job))) {
        throw new Error(
          "Legacy automation rows changed during cutover; config was retained. Stop the Gateway and rerun Doctor.",
        );
      }
      for (const agentId of new Set([...listAgentIds(cfg), ...monitors.keys()])) {
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
        if (!receipt || receipt.phase === "complete") {
          continue;
        }
        if (!jobs.some((job) => job.id === receipt.jobId)) {
          throw new Error(
            `Automation ${receipt.jobId} was deleted during cutover; legacy configuration was retained.`,
          );
        }
        recordDefaultProactiveJobInDatabase(db, storePath, agentId, receipt.jobId, Date.now());
        completed = true;
      }
      publishCronJobsStoreMutation(storePath, db);
      return completed;
    },
    { env },
    { operationLabel: "doctor.heartbeat-cutover-complete" },
  );
  if (completedCutover) {
    note(
      "Migrated heartbeats now use standard Automations delivery. Heartbeat-specific duplicate suppression and no-route skipping were removed: repeated updates can be delivered, and a missing route no longer skips the run before execution. Delivery failures follow ordinary automation handling. Review the migrated jobs' delivery settings if you relied on either behavior.",
      "Heartbeat delivery changed",
    );
  }
  if (
    [...monitors.keys()].some((agentId) => {
      const prompt = resolveHeartbeatConfig(cfg, agentId)?.prompt;
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
