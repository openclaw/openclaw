import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeBackupSchedules, type BackupScheduleSummary } from "../cron/backup-command.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/paths.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "../cron/store/read-only.js";
import {
  readBackupRuns,
  summarizeBackupFreshness,
  summarizeBackupTargets,
  type BackupRunRecord,
  type BackupRunFreshness,
} from "../state/backup-run-records.js";

// Backups older than two weeks no longer provide a useful routine recovery point.
const BACKUP_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1_000;

/** Format the compact status overview value for the latest backup attempt. */
export function buildBackupStatusValue(params: {
  freshness: BackupRunFreshness;
  now?: number;
  formatTimeAgo: (ageMs: number) => string;
}): string {
  const latest = params.freshness.latest;
  if (!latest) {
    return "none recorded";
  }
  const age = params.formatTimeAgo(Math.max(0, (params.now ?? Date.now()) - latest.createdAt));
  return latest.status === "ok"
    ? `last ok ${age} (${latest.kind}${latest.pushFailed ? ", push failing" : ""})`
    : `last attempt failed ${age} (${latest.kind})`;
}

/** Build the informational Doctor hint for missing or stale successful backups. */
function buildBackupDoctorHint(freshness: BackupRunFreshness): string | null {
  const latestOk = freshness.latestOk;
  if (latestOk?.pushFailed) {
    return [
      "The newest local Git backup succeeded, but its requested push failed.",
      `Check the configured Git remote for ${latestOk.archivePath}, then retry the backup.`,
    ].join("\n");
  }
  const stale = !latestOk || Date.now() - latestOk.createdAt > BACKUP_STALE_AFTER_MS;
  if (!stale) {
    return null;
  }
  return [
    latestOk
      ? "The newest successful backup is more than 14 days old."
      : "No successful backup is recorded.",
    `Create one now with ${formatCliCommand("openclaw backup create")}.`,
    `Schedule versioned backups with ${formatCliCommand("openclaw backup enable --repository <dir>")}.`,
  ].join("\n");
}

/** Report each scheduled destination independently of other successful backups. */
function buildOffsiteBackupDoctorHints(params: {
  runs: readonly BackupRunRecord[];
  schedules: readonly BackupScheduleSummary[];
}): string[] {
  const targets = summarizeBackupTargets(params.runs);
  const now = Date.now();
  return params.schedules.flatMap((schedule) => {
    if (schedule.mode !== "offsite" || !schedule.enabled) {
      return [];
    }
    const target = targets.find(
      (entry) =>
        entry.kind === "archive" &&
        entry.target === schedule.target &&
        entry.namespace === schedule.namespace,
    );
    const failed = target?.latest.status === "failed";
    const stale = !target?.latestOk || now - target.latestOk.createdAt > 3 * schedule.everyMs;
    if (!failed && !stale) {
      return [];
    }
    const reason = failed
      ? `The newest offsite backup attempt to ${schedule.target} failed${target.latest.error ? `: ${target.latest.error}` : "."}`
      : target?.latestOk
        ? `The newest successful offsite backup to ${schedule.target} is older than three scheduled intervals.`
        : `No successful offsite backup to ${schedule.target} is recorded.`;
    return [
      `${reason}\nCheck the destination with ${formatCliCommand(`openclaw storage test ${schedule.target}`)}.`,
    ];
  });
}

/** Emit non-repairing freshness hints; configuration and ledger reads never probe destinations. */
export async function noteBackupDoctorHint(
  env: NodeJS.ProcessEnv,
  cfg?: OpenClawConfig,
): Promise<void> {
  const runs = await readBackupRuns(env);
  const hint = buildBackupDoctorHint(summarizeBackupFreshness(runs));
  const hints = hint ? [hint] : [];
  if (cfg) {
    const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(
      resolveCronJobsStorePathFromConfig(cfg, env),
      env,
    );
    hints.push(
      ...buildOffsiteBackupDoctorHints({
        runs,
        schedules: summarizeBackupSchedules(loaded.store.jobs),
      }),
    );
  }
  if (hints.length) {
    note(hints.join("\n\n"), "Backups");
  }
}
