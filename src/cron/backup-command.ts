import { parseArgs } from "node:util";
import {
  normalizeBackupRetention,
  resolveBackupNamespace,
  type BackupRetention,
} from "../infra/backup-retention.js";
import type { CronJob, CronJobCreate } from "./types.js";

// Installed Git schedules retain this declaration and command contract.
const BACKUP_SCHEDULE_DECLARATION_KEYS = {
  git: "openclaw-backup-scheduled",
  offsite: "openclaw-backup-offsite-scheduled",
} as const;

const BACKUP_COMMANDS = {
  git: ["openclaw", "backup", "git", "create"],
  offsite: ["openclaw", "backup", "create"],
} as const;

export type BackupScheduleSpec = { everyMs: number } & (
  | {
      mode: "git";
      repository: string;
      scope: { kind: "all" | "global" } | { kind: "agent"; agentId: string };
      push: boolean;
      excludeSecrets: boolean;
    }
  | (BackupRetention & {
      mode: "offsite";
      location: string;
      namespace: string;
      claimNamespace?: boolean;
      includeWorkspace: boolean;
    })
);

export type BackupScheduleSummary = {
  id: string;
  mode: BackupScheduleSpec["mode"];
  target: string;
  namespace?: string;
  enabled: boolean;
  everyMs: number;
  nextRunAtMs?: number;
};

export function backupScheduleModeForDeclaration(
  declarationKey: string | undefined,
): BackupScheduleSpec["mode"] | undefined {
  if (declarationKey === BACKUP_SCHEDULE_DECLARATION_KEYS.git) {
    return "git";
  }
  if (declarationKey === BACKUP_SCHEDULE_DECLARATION_KEYS.offsite) {
    return "offsite";
  }
  return undefined;
}

/** Identifies managed command execution even when an operator edits its arguments. */
export function isScheduledBackupCommand(
  job: Pick<CronJob, "declarationKey" | "payload">,
): boolean {
  const mode = backupScheduleModeForDeclaration(job.declarationKey);
  const payload = job.payload;
  return (
    mode !== undefined &&
    payload.kind === "command" &&
    BACKUP_COMMANDS[mode].every((part, index) => payload.argv[index] === part)
  );
}

export function buildBackupScheduleJob(spec: BackupScheduleSpec): CronJobCreate {
  const argv: string[] = [...BACKUP_COMMANDS[spec.mode]];
  if (spec.mode === "git") {
    argv.push("--repository", spec.repository);
    argv.push(
      ...(spec.scope.kind === "agent" ? ["--agent", spec.scope.agentId] : [`--${spec.scope.kind}`]),
    );
    if (spec.push) {
      argv.push("--push");
    }
    if (spec.excludeSecrets) {
      argv.push("--exclude-secrets");
    }
  } else {
    argv.push("--to", spec.location, "--namespace", spec.namespace);
    if (spec.claimNamespace) {
      argv.push("--claim-namespace");
    }
    if (!spec.includeWorkspace) {
      argv.push("--no-include-workspace");
    }
    for (const [flag, value] of [
      ["--keep-daily", spec.keepDaily],
      ["--keep-weekly", spec.keepWeekly],
      ["--keep-monthly", spec.keepMonthly],
    ] as const) {
      if (value !== undefined) {
        argv.push(flag, String(value));
      }
    }
  }
  const declarationKey = BACKUP_SCHEDULE_DECLARATION_KEYS[spec.mode];
  return {
    declarationKey,
    name: declarationKey,
    enabled: true,
    schedule: { kind: "every", everyMs: spec.everyMs },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv },
    delivery: { mode: "none" },
  };
}

/** Decode the persisted argv contract for status without relying on display names. */
function parseBackupScheduleJob(
  job: Pick<CronJob, "declarationKey" | "payload" | "schedule">,
): BackupScheduleSpec | undefined {
  const mode = backupScheduleModeForDeclaration(job.declarationKey);
  if (
    !mode ||
    !isScheduledBackupCommand(job) ||
    job.payload.kind !== "command" ||
    job.schedule.kind !== "every"
  ) {
    return undefined;
  }
  const everyMs = job.schedule.everyMs;
  try {
    const args = job.payload.argv.slice(BACKUP_COMMANDS[mode].length);
    if (mode === "git") {
      const { values } = parseArgs({
        args,
        options: {
          repository: { type: "string" },
          all: { type: "boolean" },
          global: { type: "boolean" },
          agent: { type: "string" },
          push: { type: "boolean" },
          "exclude-secrets": { type: "boolean" },
        },
      });
      if (
        !values.repository ||
        [values.all, values.global, values.agent].filter(Boolean).length > 1
      ) {
        return undefined;
      }
      return {
        mode,
        everyMs,
        repository: values.repository,
        scope: values.agent
          ? { kind: "agent", agentId: values.agent }
          : { kind: values.global ? "global" : "all" },
        push: values.push === true,
        excludeSecrets: values["exclude-secrets"] === true,
      };
    }
    const { values } = parseArgs({
      args,
      options: {
        to: { type: "string" },
        namespace: { type: "string" },
        "claim-namespace": { type: "boolean" },
        "no-include-workspace": { type: "boolean" },
        "keep-daily": { type: "string" },
        "keep-weekly": { type: "string" },
        "keep-monthly": { type: "string" },
      },
    });
    if (!values.to) {
      return undefined;
    }
    return {
      mode,
      everyMs,
      location: values.to,
      namespace: resolveBackupNamespace(values.namespace),
      claimNamespace: values["claim-namespace"] === true,
      includeWorkspace: values["no-include-workspace"] !== true,
      ...normalizeBackupRetention({
        keepDaily: values["keep-daily"],
        keepWeekly: values["keep-weekly"],
        keepMonthly: values["keep-monthly"],
      }),
    };
  } catch {
    return undefined;
  }
}

export function summarizeBackupSchedules(jobs: readonly CronJob[]): BackupScheduleSummary[] {
  return jobs.flatMap((job) => {
    const spec = parseBackupScheduleJob(job);
    return spec
      ? [
          {
            id: job.id,
            mode: spec.mode,
            target: spec.mode === "git" ? spec.repository : spec.location,
            ...(spec.mode === "offsite" ? { namespace: spec.namespace } : {}),
            enabled: job.enabled,
            everyMs: spec.everyMs,
            ...(job.state.nextRunAtMs === undefined ? {} : { nextRunAtMs: job.state.nextRunAtMs }),
          },
        ]
      : [];
  });
}
