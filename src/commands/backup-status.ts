// Backup status is a read-only projection over the recorded run ledger, the cron
// schedule store, and storage locations — the same trio the backup.status RPC
// summarizes.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeBackupSchedules } from "../cron/backup-command.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/paths.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "../cron/store/read-only.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import { getLoadedRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  readBackupRuns,
  summarizeBackupFreshness,
  summarizeBackupTargets,
} from "../state/backup-run-records.js";
import { listStorageLocations } from "../storage/locations.js";
import { buildBackupDoctorHints, buildBackupStatusValue } from "./backup-health.js";

type BackupTarget = ReturnType<typeof summarizeBackupTargets>[number];
type BackupSchedule = ReturnType<typeof summarizeBackupSchedules>[number];

export type BackupStatusSnapshot = {
  freshnessValue: string;
  targets: BackupTarget[];
  schedules: BackupSchedule[];
  locations: Array<{ name: string }>;
  config: OpenClawConfig;
};

export async function loadBackupStatusSnapshot(
  env: NodeJS.ProcessEnv,
): Promise<BackupStatusSnapshot> {
  const runs = await readBackupRuns(env);
  const cfg = loadConfig();
  const jobs = await loadCronJobsStoreWithConfigJobsReadOnly(
    resolveCronJobsStorePathFromConfig(cfg, env),
    env,
  );
  const freshness = summarizeBackupFreshness(runs);
  return {
    freshnessValue: buildBackupStatusValue({ freshness, formatTimeAgo }),
    targets: summarizeBackupTargets(runs),
    schedules: summarizeBackupSchedules(jobs.store.jobs),
    locations: listStorageLocations(cfg, getLoadedRuntimePluginRegistry() ?? undefined),
    config: cfg,
  };
}

function describeTargetAge(target: BackupTarget): string {
  return formatTimeAgo(Math.max(0, Date.now() - target.latest.createdAt));
}

function describeSchedule(schedule: BackupSchedule): string {
  return `${schedule.enabled ? "" : "disabled "}${schedule.mode} ${sanitizeTerminalText(schedule.target)}${schedule.namespace ? ` (${sanitizeTerminalText(schedule.namespace)})` : ""}`;
}

export function renderBackupStatus(snapshot: BackupStatusSnapshot): string {
  const lines: string[] = [
    `${theme.heading("Backup status")} ${theme.muted(snapshot.freshnessValue)}`,
  ];
  if (snapshot.targets.length > 0) {
    lines.push(
      renderTable({
        width: getTerminalTableWidth(),
        columns: [
          { key: "Kind", header: "Kind", minWidth: 8 },
          { key: "Target", header: "Target", minWidth: 16, flex: true },
          { key: "Status", header: "Status", minWidth: 8 },
          { key: "Age", header: "Age", minWidth: 10 },
        ],
        rows: snapshot.targets.map((target) => ({
          Kind: target.kind,
          Target: sanitizeTerminalText(
            target.namespace ? `${target.target} (${target.namespace})` : target.target,
          ).slice(0, 60),
          Status: target.latest.status,
          Age: describeTargetAge(target),
        })),
      }).trimEnd(),
    );
  } else {
    lines.push("No recorded backup runs.");
  }
  const enabledSchedules = snapshot.schedules.filter((schedule) => schedule.enabled);
  if (snapshot.schedules.length > 0) {
    lines.push(
      `${theme.muted("Schedules:")} ${enabledSchedules.length}/${snapshot.schedules.length} enabled`,
    );
    for (const schedule of enabledSchedules) {
      lines.push(`  ${describeSchedule(schedule)}`);
    }
  }
  if (snapshot.locations.length > 0) {
    lines.push(
      `${theme.muted("Locations:")} ${snapshot.locations
        .map((location) => sanitizeTerminalText(location.name))
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

export async function backupStatusCommand(runtime: RuntimeEnv): Promise<void> {
  const env = process.env;
  const snapshot = await loadBackupStatusSnapshot(env);
  runtime.log(renderBackupStatus(snapshot));
  const hints = await buildBackupDoctorHints(env, snapshot.config);
  for (const hint of hints) {
    runtime.log(hint);
  }
}
