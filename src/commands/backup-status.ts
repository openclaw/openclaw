// Backup status is a read-only projection over the recorded run ledger, the cron
// schedule store, and storage locations — the same trio the backup.status RPC
// summarizes. When the selected Gateway is not this host's implicit local gateway,
// the projection must come from that Gateway instead of process-local state.
import type { BackupStatusResult } from "../../packages/gateway-protocol/src/schema/backup.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeBackupSchedules } from "../cron/backup-command.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/paths.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "../cron/store/read-only.js";
import {
  buildGatewayConnectionDetails,
  callGateway,
  isImplicitLocalGatewayTarget,
} from "../gateway/call.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import { getLoadedRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  readBackupRuns,
  summarizeBackupFreshness,
  summarizeBackupTargets,
} from "../state/backup-run-records.js";
import { listStorageLocations } from "../storage/locations.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildBackupDoctorHintsFromState, buildBackupStatusValue } from "./backup-health.js";

type BackupTarget = ReturnType<typeof summarizeBackupTargets>[number];
type BackupSchedule = ReturnType<typeof summarizeBackupSchedules>[number];

export type BackupStatusSnapshot = {
  freshnessValue: string;
  targets: BackupTarget[];
  schedules: BackupSchedule[];
  locations: Array<{ name: string }>;
  source: string;
  hints: string[];
};

async function loadLocalBackupStatusSnapshot(
  env: NodeJS.ProcessEnv,
  cfg: OpenClawConfig,
): Promise<BackupStatusSnapshot> {
  const runs = await readBackupRuns(env);
  const jobs = await loadCronJobsStoreWithConfigJobsReadOnly(
    resolveCronJobsStorePathFromConfig(cfg, env),
    env,
  );
  const freshness = summarizeBackupFreshness(runs);
  const targets = summarizeBackupTargets(runs);
  const schedules = summarizeBackupSchedules(jobs.store.jobs);
  return {
    freshnessValue: buildBackupStatusValue({ freshness, formatTimeAgo }),
    targets,
    schedules,
    locations: listStorageLocations(cfg, getLoadedRuntimePluginRegistry() ?? undefined),
    source: "local process state",
    hints: buildBackupDoctorHintsFromState({ freshness, targets, schedules }),
  };
}

async function loadSelectedGatewayBackupStatus(cfg: OpenClawConfig): Promise<BackupStatusSnapshot> {
  const { url } = buildGatewayConnectionDetails({ config: cfg });
  let result: BackupStatusResult;
  try {
    result = await callGateway<BackupStatusResult>({
      config: cfg,
      expectUrl: url,
      method: "backup.status",
      params: {},
      mode: GATEWAY_CLIENT_MODES.CLI,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      requiredMethods: ["backup.status"],
    });
  } catch (error) {
    throw new Error(
      `Backup status could not read the selected Gateway at ${url}: ${error instanceof Error ? error.message : String(error)}. Run this on the Gateway host or fix gateway.remote.url.`,
      { cause: error },
    );
  }
  const freshness = summarizeFreshnessFromTargets(result.targets);
  return {
    freshnessValue: buildBackupStatusValue({ freshness, formatTimeAgo }),
    targets: result.targets,
    schedules: result.schedules,
    locations: result.locations,
    source: `selected Gateway ${url}`,
    hints: buildBackupDoctorHintsFromState({
      freshness,
      targets: result.targets,
      schedules: result.schedules,
    }),
  };
}

/** The selected Gateway owns these rows: a client must not project its own empty ledger. */
export async function loadBackupStatusSnapshot(
  env: NodeJS.ProcessEnv,
): Promise<BackupStatusSnapshot> {
  const cfg = loadConfig();
  if (!(await isImplicitLocalGatewayTarget({ config: cfg }))) {
    return await loadSelectedGatewayBackupStatus(cfg);
  }
  return await loadLocalBackupStatusSnapshot(env, cfg);
}

/** Newest run across every target, matching summarizeBackupFreshness over the same ledger. */
function summarizeFreshnessFromTargets(targets: readonly BackupTarget[]) {
  let latest: BackupTarget["latest"] | undefined;
  let latestOk: NonNullable<BackupTarget["latestOk"]> | undefined;
  for (const target of targets) {
    if (!latest || target.latest.createdAt > latest.createdAt) {
      latest = target.latest;
    }
    const ok = target.latestOk;
    if (ok && (!latestOk || ok.createdAt > latestOk.createdAt)) {
      latestOk = ok;
    }
  }
  return { ...(latest ? { latest } : {}), ...(latestOk ? { latestOk } : {}) };
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
    theme.muted(`Source: ${sanitizeTerminalText(snapshot.source)}`),
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
  const snapshot = await loadBackupStatusSnapshot(process.env);
  runtime.log(renderBackupStatus(snapshot));
  for (const hint of snapshot.hints) {
    runtime.log(hint);
  }
}
