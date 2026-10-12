import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { listCronJobsFromGateway } from "../cli/cron-cli/list-jobs.js";
import {
  callGatewayFromCli,
  isImplicitLocalGatewayTargetFromCli,
  type GatewayRpcOpts,
} from "../cli/gateway-rpc.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  backupScheduleModeForDeclaration,
  buildBackupScheduleJob,
  type BackupScheduleSpec,
} from "../cron/backup-command.js";
import {
  normalizeBackupRetention,
  resolveBackupNamespace,
  type BackupRetentionOptions,
} from "../infra/backup-retention.js";
import { executeGitCommand } from "../infra/git-exec.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { GIT_BACKUP_PUSH_CREDENTIAL_WARNING } from "./backup-git.js";
import { resolveRequiredBackupPath } from "./backup-shared.js";

const LOCAL_GATEWAY_REQUIRED_ERROR =
  "backup enable manages backups on the Gateway host and currently requires a local Gateway. Create the cron job manually with openclaw cron add for remote Gateways.";

export type BackupScheduleOptions = GatewayRpcOpts &
  BackupRetentionOptions & {
    repository?: string;
    every?: string;
    push?: boolean;
    excludeSecrets?: boolean;
    includeSecrets?: boolean;
    globalOnly?: boolean;
    agent?: string;
    to?: string;
    namespace?: string;
    claimNamespace?: boolean;
    includeWorkspace?: boolean;
  };

export type BackupDisableOptions = GatewayRpcOpts & { git?: boolean; offsite?: boolean };

/**
 * Unattended pushed schedules make credential retention durable in remote
 * history, so they redact by default; --include-secrets is the explicit
 * full-fidelity override. Local (non-push) schedules keep full fidelity for
 * complete restores.
 */
function resolveScheduledRedaction(options: BackupScheduleOptions): boolean {
  if (options.excludeSecrets && options.includeSecrets) {
    throw new Error("Use either --exclude-secrets or --include-secrets, not both.");
  }
  if (!options.push) {
    return options.excludeSecrets === true;
  }
  return options.includeSecrets !== true;
}

function resolveScheduleSpec(options: BackupScheduleOptions, everyMs: number): BackupScheduleSpec {
  if (options.to !== undefined) {
    if (
      options.repository !== undefined ||
      options.push ||
      options.excludeSecrets ||
      options.includeSecrets ||
      options.globalOnly ||
      options.agent !== undefined
    ) {
      throw new Error(
        "--to cannot be combined with Git backup options (--repository, --push, --exclude-secrets, --include-secrets, --global-only, --agent).",
      );
    }
    const location = options.to.trim();
    if (!location) {
      throw new Error("--to must name a configured storage location.");
    }
    if (!getRuntimeConfig({ skipPluginValidation: true }).storage?.locations?.[location]) {
      throw new Error(
        `Storage location "${location}" is not configured. Run openclaw storage list.`,
      );
    }
    return {
      mode: "offsite",
      everyMs,
      location,
      namespace: resolveBackupNamespace(options.namespace),
      claimNamespace: options.claimNamespace === true,
      includeWorkspace: options.includeWorkspace !== false,
      ...normalizeBackupRetention(options),
    };
  }
  if (
    options.namespace !== undefined ||
    options.claimNamespace ||
    options.includeWorkspace === false ||
    options.keepDaily !== undefined ||
    options.keepWeekly !== undefined ||
    options.keepMonthly !== undefined
  ) {
    throw new Error(
      "--namespace, --claim-namespace, --no-include-workspace, and --keep-* require --to <location>.",
    );
  }
  const repository = resolveRequiredBackupPath(options.repository, "--repository");
  const agent = options.agent?.trim();
  if (options.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }
  if (options.globalOnly && agent) {
    throw new Error("Use either --global-only or --agent <id>, not both.");
  }
  const agentId = agent
    ? resolveConfiguredAgentId(
        getRuntimeConfig({ skipPluginValidation: true }),
        normalizeAgentId(agent),
      )
    : undefined;
  return {
    mode: "git",
    everyMs,
    repository,
    scope: options.globalOnly
      ? { kind: "global" }
      : agentId
        ? { kind: "agent", agentId }
        : { kind: "all" },
    push: options.push === true,
    excludeSecrets: resolveScheduledRedaction(options),
  };
}

async function assertLocalGatewayScheduleTarget(options: GatewayRpcOpts): Promise<void> {
  // V1 tradeoff: the CLI validates host-local repository paths, while cron runs
  // on the Gateway host. Reject remote targets until Gateway-owned setup exists.
  if (!(await isImplicitLocalGatewayTargetFromCli(options))) {
    throw new Error(LOCAL_GATEWAY_REQUIRED_ERROR);
  }
}

export async function backupEnableCommand(
  runtime: RuntimeEnv,
  options: BackupScheduleOptions,
): Promise<{ id: string; updated: boolean }> {
  await assertLocalGatewayScheduleTarget(options);
  // Explicit blanks must reach duration validation instead of creating a default schedule.
  const every = options.every?.trim() ?? "24h";
  const everyMs = parseDurationMs(every, { defaultUnit: "ms" });
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0) {
    throw new Error("--every must be a positive duration such as 6h or 24h.");
  }
  const spec = resolveScheduleSpec(options, everyMs);
  if (spec.mode === "git" && spec.push) {
    // The unattended job cannot configure a remote; without this preflight the
    // first scheduled run records a degraded push-failed backup instead.
    const origin = await executeGitCommand(spec.repository, ["remote", "get-url", "origin"]);
    if (origin.code !== 0) {
      throw new Error(
        `--push requires an origin remote. Run: openclaw backup git init --repository ${shortenHomePath(spec.repository)} --remote <url>`,
      );
    }
    if (!spec.excludeSecrets) {
      runtime.error(GIT_BACKUP_PUSH_CREDENTIAL_WARNING);
    }
  }
  const result = (await callGatewayFromCli("cron.add", options, buildBackupScheduleJob(spec))) as {
    created?: boolean;
    updated?: boolean;
    job?: { id?: string };
  };
  const id = result.job?.id;
  if (!id) {
    throw new Error("cron.add returned no scheduled backup job id.");
  }
  const updated = result.created === false;
  runtime.log(
    `Scheduled ${spec.mode === "git" ? "Git" : "offsite"} backups ${updated ? "updated" : "enabled"}: every ${every} to ${spec.mode === "git" ? shortenHomePath(spec.repository) : spec.location}`,
  );
  return { id, updated };
}

export async function backupDisableCommand(
  runtime: RuntimeEnv,
  options: BackupDisableOptions,
): Promise<{ removed: boolean }> {
  await assertLocalGatewayScheduleTarget(options);
  if (options.git && options.offsite) {
    throw new Error("Use either --git or --offsite, or omit both to disable all backup schedules.");
  }
  const { jobs } = await listCronJobsFromGateway(options, { includeDisabled: true });
  const selectedMode = options.git ? "git" : options.offsite ? "offsite" : undefined;
  const existing = jobs.filter((job) => {
    const mode = backupScheduleModeForDeclaration(job.declarationKey);
    return mode !== undefined && (selectedMode === undefined || mode === selectedMode);
  });
  const label =
    selectedMode === "git"
      ? "Scheduled Git backups"
      : selectedMode === "offsite"
        ? "Scheduled offsite backups"
        : "Scheduled backups";
  if (existing.length === 0) {
    runtime.log(`${label} are already disabled.`);
    return { removed: false };
  }
  for (const job of existing) {
    await callGatewayFromCli("cron.remove", options, { id: job.id });
  }
  runtime.log(`${label} disabled.`);
  return { removed: true };
}
