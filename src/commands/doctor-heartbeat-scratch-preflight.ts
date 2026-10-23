import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.kernel.js";
import { cronStoreKey } from "../cron/store/key.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/paths.js";
import { loadCronRows } from "../cron/store/row-codec.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { decodeDoctorHeartbeatJobRows } from "./doctor-heartbeat-jobs.js";
import {
  planDoctorHeartbeatMonitors,
  resolveDoctorHeartbeatReceiptJob,
  selectDoctorHeartbeatMonitor,
} from "./doctor-heartbeat-monitors.js";
import { collectHeartbeatScratchMigrationFindings } from "./doctor-heartbeat-scratch-migration.js";
import { collectHeartbeatTaskMigrationFindings } from "./doctor-heartbeat-task-migration.js";

/** Validate source safety, task conversion, and monitor ownership without entering repair. */
export async function assertHeartbeatScratchMigrationUnambiguous(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const cfg = inheritLegacyDefaultAgentId(sourceConfig, structuredClone(sourceConfig));
  const findings = (
    await Promise.all([
      collectHeartbeatScratchMigrationFindings(cfg, env),
      collectHeartbeatTaskMigrationFindings(cfg, env),
    ])
  ).flat();
  if (findings.length === 0) {
    return;
  }
  const blocked = findings.find((finding) => finding.severity === "error");
  if (blocked) {
    throw new Error(blocked.message);
  }
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => {
      const jobs = decodeDoctorHeartbeatJobRows(loadCronRows(db, cronStoreKey(storePath)));
      const { agentIds, receipts } = planDoctorHeartbeatMonitors(
        cfg,
        jobs,
        (agentId) => readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId),
        findings.flatMap((finding) => (finding.target ? [finding.target] : [])),
      );
      for (const agentId of agentIds) {
        const receipt = receipts.get(agentId);
        const previous = selectDoctorHeartbeatMonitor(jobs, agentId);
        if (receipt) {
          resolveDoctorHeartbeatReceiptJob(cfg, jobs, agentId, receipt, previous);
        }
      }
    },
    { env },
  );
}
