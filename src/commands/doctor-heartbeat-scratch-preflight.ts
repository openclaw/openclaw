import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.kernel.js";
import { readScratchStateFromDatabase } from "../cron/scratch-read.kernel.js";
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
import {
  collectHeartbeatScratchMigrationFindings,
  completedHeartbeatSourceWarning,
  heartbeatScratchMigrationConflict,
  readHeartbeatSource,
  shouldInspectHeartbeatScratchSource,
} from "./doctor-heartbeat-scratch-migration.js";

/** Published canaries omit workspace files; inspect originals without entering repair. */
export async function assertHeartbeatScratchMigrationUnambiguous(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const cfg = inheritLegacyDefaultAgentId(sourceConfig, structuredClone(sourceConfig));
  const findings = await collectHeartbeatScratchMigrationFindings(cfg, env);
  if (findings.length === 0) {
    return;
  }
  const blocked = findings.find((finding) => finding.severity === "error");
  if (blocked) {
    throw new Error(blocked.message);
  }
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const destinations = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => {
      const jobs = decodeDoctorHeartbeatJobRows(loadCronRows(db, cronStoreKey(storePath)));
      const { agentIds, receipts } = planDoctorHeartbeatMonitors(
        cfg,
        jobs,
        (agentId) => readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId),
        findings.flatMap((finding) => (finding.target ? [finding.target] : [])),
      );
      return new Map(
        [...agentIds].map((agentId) => {
          const receipt = receipts.get(agentId);
          const previous = selectDoctorHeartbeatMonitor(jobs, agentId);
          const monitor = receipt
            ? resolveDoctorHeartbeatReceiptJob(cfg, jobs, agentId, receipt, previous)
            : previous;
          return [
            agentId,
            {
              inspect: shouldInspectHeartbeatScratchSource(
                receipt ? Boolean(monitor) : true,
                receipt,
              ),
              complete: receipt?.phase === "complete",
              scratch: monitor
                ? readScratchStateFromDatabase(db, cronStoreKey(storePath), monitor.id)
                : { currentRevision: 0 },
            },
          ];
        }),
      );
    },
    { env },
  );
  for (const [agentId, destination] of destinations ?? []) {
    if (!destination.inspect) {
      continue;
    }
    const source = await readHeartbeatSource(cfg, agentId, { env });
    if (!source) {
      continue;
    }
    if (destination.complete) {
      throw new Error(completedHeartbeatSourceWarning(agentId));
    }
    const conflict = heartbeatScratchMigrationConflict(
      agentId,
      source.content,
      destination.scratch,
    );
    if (conflict) {
      throw new Error(conflict);
    }
  }
}
