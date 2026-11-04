import { note } from "../../packages/terminal-core/src/note.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeBackupSchedules } from "../cron/backup-command.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/paths.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "../cron/store/read-only.js";
import {
  readBackupRuns,
  summarizeBackupFreshness,
  summarizeBackupTargets,
  type BackupRunFreshness,
} from "../state/backup-run-records.js";

// Backups older than two weeks no longer provide a useful routine recovery point.
const BACKUP_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * Minimal run view shared by the local ledger and the selected Gateway's backup.status result,
 * so both sources describe freshness and hints with one implementation.
 */
type BackupRunView = {
  status: "ok" | "failed";
  createdAt: number;
  kind: string;
  archivePath: string;
  pushFailed?: true;
  error?: string;
};

type BackupFreshnessView = { latest?: BackupRunView; latestOk?: BackupRunView };

type BackupTargetView = {
  kind: string;
  target: string;
  namespace?: string;
  latest: BackupRunView;
  latestOk?: BackupRunView;
};

type BackupScheduleView = {
  mode: string;
  target: string;
  namespace?: string;
  enabled: boolean;
  everyMs: number;
};

export function buildBackupStatusValue(params: {
  freshness: BackupFreshnessView;
  formatTimeAgo: (ageMs: number) => string;
}): string {
  const latest = params.freshness.latest;
  if (!latest) {
    return "none recorded";
  }
  const age = params.formatTimeAgo(Math.max(0, Date.now() - latest.createdAt));
  return latest.status === "ok"
    ? `last ok ${age} (${latest.kind}${latest.pushFailed ? ", push failing" : ""})`
    : `last attempt failed ${age} (${latest.kind})`;
}

function buildBackupDoctorHint(freshness: BackupFreshnessView): string | null {
  const latestOk = freshness.latestOk;
  if (latestOk?.pushFailed) {
    return [
      "The newest local Git backup succeeded, but its requested push failed.",
      terminalText`Check the configured Git remote for ${latestOk.archivePath}, then retry the backup.`,
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

/** Emit non-repairing freshness hints from one already-loaded state view; no probe, no repair. */
export function buildBackupDoctorHintsFromState(state: {
  freshness: BackupFreshnessView;
  targets: readonly BackupTargetView[];
  schedules: readonly BackupScheduleView[];
}): string[] {
  const hint = buildBackupDoctorHint(state.freshness);
  const hints = hint ? [hint] : [];
  const now = Date.now();
  // Report each scheduled destination independently of other successful backups.
  hints.push(
    ...state.schedules.flatMap((schedule) => {
      if (schedule.mode !== "offsite" || !schedule.enabled) {
        return [];
      }
      const target = state.targets.find(
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
        ? terminalText`The newest offsite backup attempt to ${schedule.target} failed${target.latest.error ? `: ${target.latest.error}` : "."}`
        : target?.latestOk
          ? terminalText`The newest successful offsite backup to ${schedule.target} is older than three scheduled intervals.`
          : terminalText`No successful offsite backup to ${schedule.target} is recorded.`;
      return [
        `${reason}\nCheck the destination with ${formatCliCommand(terminalText`openclaw storage test ${schedule.target}`)}.`,
      ];
    }),
  );
  return hints;
}

export async function buildBackupDoctorHints(
  env: NodeJS.ProcessEnv,
  cfg?: OpenClawConfig,
): Promise<string[]> {
  const runs = await readBackupRuns(env);
  const freshness: BackupRunFreshness = summarizeBackupFreshness(runs);
  const schedules = cfg
    ? summarizeBackupSchedules(
        (
          await loadCronJobsStoreWithConfigJobsReadOnly(
            resolveCronJobsStorePathFromConfig(cfg, env),
            env,
          )
        ).store.jobs,
      )
    : [];
  return buildBackupDoctorHintsFromState({
    freshness,
    targets: summarizeBackupTargets(runs),
    schedules,
  });
}

export async function noteBackupDoctorHint(
  env: NodeJS.ProcessEnv,
  cfg?: OpenClawConfig,
): Promise<void> {
  const hints = await buildBackupDoctorHints(env, cfg);
  if (hints.length) {
    note(hints.join("\n\n"), "Backups");
  }
}
