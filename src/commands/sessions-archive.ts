import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import {
  formatArchiveReason,
  runSessionsArchive,
  type SessionArchiveAction,
  type SessionArchiveActionRow,
  type SessionArchiveSkipReason,
  type SessionArchiveSummary,
  type SessionsArchiveOptions,
} from "./sessions-archive-core.js";
import {
  formatSessionAgeCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  resolveSessionDisplayDefaults,
  resolveSessionDisplayModel,
  SESSION_AGE_PAD,
  SESSION_KEY_PAD,
  SESSION_MODEL_PAD,
} from "./sessions-table.js";

export type SessionsArchiveCommandOptions = SessionsArchiveOptions & {
  json?: boolean;
};

const ACTION_PAD = 8;
const STATUS_PAD = 9;
const REASON_PAD = 22;

function formatArchiveActionCell(action: SessionArchiveAction, rich: boolean): string {
  const label = action.padEnd(ACTION_PAD);
  if (!rich) {
    return label;
  }
  return action === "archive" ? theme.success(label) : theme.warn(label);
}

function formatArchiveStatusCell(status: string | null, rich: boolean): string {
  const label = (status ?? "unknown").padEnd(STATUS_PAD);
  if (!rich) {
    return label;
  }
  if (status === "done") {
    return theme.success(label);
  }
  if (status === "killed" || status === "timeout") {
    return theme.warn(label);
  }
  if (status === "running" || status === "active") {
    return theme.error(label);
  }
  return theme.muted(label);
}

function formatArchiveReasonCell(reason: SessionArchiveSkipReason | null, rich: boolean): string {
  const label = formatArchiveReason(reason).padEnd(REASON_PAD);
  if (!rich) {
    return label;
  }
  return reason ? theme.warn(label) : theme.muted(label);
}

function renderStoreArchivePlan(params: {
  cfg: ReturnType<typeof loadConfig>;
  summary: SessionArchiveSummary;
  actionRows: SessionArchiveActionRow[];
  runtime: RuntimeEnv;
  showAgentHeader: boolean;
  displayDefaults: ReturnType<typeof resolveSessionDisplayDefaults>;
}) {
  const rich = isRich();
  if (params.showAgentHeader) {
    params.runtime.log(`Agent: ${params.summary.agentId}`);
  }
  params.runtime.log(`Session store: ${params.summary.storePath}`);
  if (params.summary.requestedKey) {
    params.runtime.log(`Requested session: ${params.summary.requestedKey}`);
  } else {
    if (params.summary.status) {
      params.runtime.log(`Status filter: ${params.summary.status}`);
    }
    if (params.summary.olderThan) {
      params.runtime.log(`Age filter: older than ${params.summary.olderThan}`);
    }
  }
  params.runtime.log(`Matched sessions: ${params.summary.matched}`);
  params.runtime.log(
    `${params.summary.dryRun ? "Would archive" : "Archived"}: ${params.summary.archived}`,
  );
  params.runtime.log(`Skipped protected/active sessions: ${params.summary.skipped}`);
  params.runtime.log(`Transcript files archived: ${params.summary.transcriptFilesArchived}`);
  if (params.actionRows.length === 0) {
    params.runtime.log("No sessions matched the requested selectors.");
    return;
  }

  params.runtime.log("");
  params.runtime.log(params.summary.dryRun ? "Planned session actions:" : "Session actions:");
  const header = [
    "Action".padEnd(ACTION_PAD),
    "Status".padEnd(STATUS_PAD),
    "Key".padEnd(SESSION_KEY_PAD),
    "Age".padEnd(SESSION_AGE_PAD),
    "Model".padEnd(SESSION_MODEL_PAD),
    "Reason".padEnd(REASON_PAD),
  ].join(" ");
  params.runtime.log(rich ? theme.heading(header) : header);
  for (const actionRow of params.actionRows) {
    const model = resolveSessionDisplayModel(params.cfg, actionRow, params.displayDefaults);
    const line = [
      formatArchiveActionCell(actionRow.action, rich),
      formatArchiveStatusCell(actionRow.status, rich),
      formatSessionKeyCell(actionRow.key, rich),
      formatSessionAgeCell(actionRow.updatedAt, rich),
      formatSessionModelCell(model, rich),
      formatArchiveReasonCell(actionRow.reason, rich),
    ].join(" ");
    params.runtime.log(line.trimEnd());
  }
}

export async function sessionsArchiveCommand(
  opts: SessionsArchiveCommandOptions,
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const displayDefaults = resolveSessionDisplayDefaults(cfg);

  let result;
  try {
    result = await runSessionsArchive(opts, cfg);
  } catch (error) {
    runtime.error(error instanceof Error ? error.message : String(error));
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    if (result.stores.length === 1) {
      runtime.log(JSON.stringify(result.stores[0]?.summary ?? {}, null, 2));
      return;
    }
    runtime.log(
      JSON.stringify(
        {
          allAgents: result.allAgents,
          dryRun: Boolean(opts.dryRun),
          requestedKey: result.requestedKey,
          status: result.status,
          olderThan: result.olderThan,
          stores: result.stores.map((store) => store.summary),
        },
        null,
        2,
      ),
    );
    return;
  }

  for (let i = 0; i < result.stores.length; i += 1) {
    const store = result.stores[i];
    if (i > 0) {
      runtime.log("");
    }
    renderStoreArchivePlan({
      cfg,
      summary: store.summary,
      actionRows: store.actionRows,
      runtime,
      showAgentHeader: result.stores.length > 1,
      displayDefaults,
    });
  }
}
