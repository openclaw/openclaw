// The update ledger already records every attempt; `update status` prints only the
// newest one, so repeated failures and rollbacks need their own list surface.
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../../packages/terminal-core/src/table.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { toPublicUpdateRun, type UpdateRunRecord } from "../../infra/update-run-record.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";

export const UPDATE_HISTORY_DEFAULT_LIMIT = 10;
export const UPDATE_HISTORY_MAX_LIMIT = 100;

type PublicUpdateRun = ReturnType<typeof toPublicUpdateRun>;

/** The ledger reads stay pluggable so this surface never owns its own state access. */
export type UpdateHistorySource = {
  list: (input: { limit: number }) => UpdateRunRecord[];
  get: (runId: string) => UpdateRunRecord | undefined;
};

export type UpdateHistoryOptions = {
  limit?: number;
  runId?: string;
  json?: boolean;
};

async function defaultSource(): Promise<UpdateHistorySource> {
  const { getUpdateRun, listUpdateRuns } = await import("../../infra/update-run-reader.js");
  return { list: listUpdateRuns, get: getUpdateRun };
}

function describeTarget(run: PublicUpdateRun): string {
  const label = run.target.version ?? run.target.tag ?? run.target.sha;
  return label ? sanitizeTerminalText(label).slice(0, 40) : "—";
}

function describeReason(run: PublicUpdateRun): string {
  const reason = run.reason?.trim();
  return reason ? sanitizeTerminalText(reason).slice(0, 60) : "";
}

export function renderUpdateHistory(runs: PublicUpdateRun[]): string {
  if (runs.length === 0) {
    return "No recorded update runs.";
  }
  return renderTable({
    width: getTerminalTableWidth(),
    columns: [
      { key: "When", header: "When", minWidth: 20 },
      { key: "Status", header: "Status", minWidth: 9 },
      { key: "Phase", header: "Phase", minWidth: 8 },
      { key: "Trigger", header: "Trigger", minWidth: 10 },
      { key: "Target", header: "Target", minWidth: 10, flex: true },
      { key: "Reason", header: "Reason", minWidth: 12, flex: true },
    ],
    rows: runs.map((run) => ({
      When: new Date(run.createdAtMs).toISOString(),
      Status: run.status,
      Phase: run.phase,
      Trigger: run.trigger,
      Target: describeTarget(run),
      Reason: describeReason(run),
    })),
  }).trimEnd();
}

export async function updateHistoryCommand(
  opts: UpdateHistoryOptions,
  runtime: RuntimeEnv,
  source?: UpdateHistorySource,
): Promise<void> {
  const runId = opts.runId?.trim();
  if (opts.runId !== undefined && !runId) {
    throw new Error("--run must not be blank");
  }
  const limit = Math.min(
    Math.max(opts.limit ?? UPDATE_HISTORY_DEFAULT_LIMIT, 1),
    UPDATE_HISTORY_MAX_LIMIT,
  );
  const reads = source ?? (await defaultSource());

  if (runId) {
    const run = reads.get(runId);
    if (!run) {
      runtime.error(
        `No recorded update run ${sanitizeTerminalText(runId)}. Run ${formatCliCommand("openclaw update history")} to list recorded runs.`,
      );
      runtime.exit(1);
      return;
    }
    const publicRun = toPublicUpdateRun(run);
    if (opts.json) {
      writeRuntimeJson(runtime, publicRun);
      return;
    }
    const report = renderUpdateRunReport(publicRun);
    runtime.log(report.headline);
    for (const line of report.lines) {
      runtime.log(line);
    }
    return;
  }

  const runs = reads.list({ limit }).map(toPublicUpdateRun);
  if (opts.json) {
    writeRuntimeJson(runtime, { runs });
    return;
  }
  runtime.log(renderUpdateHistory(runs));
  if (runs.length >= limit) {
    runtime.log(
      theme.muted(
        `Showing the ${limit} most recent runs; raise --limit for more (max ${UPDATE_HISTORY_MAX_LIMIT}).`,
      ),
    );
  }
}
