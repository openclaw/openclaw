// The update ledger already records every attempt; `update status` prints only the
// newest one, so repeated failures and rollbacks need their own list surface.
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../../packages/terminal-core/src/table.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-reader.js";
import { toPublicUpdateRun } from "../../infra/update-run-record.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { withUpdateDatabaseEngine } from "./update-command-database-engine.js";

export const UPDATE_HISTORY_DEFAULT_LIMIT = 10;
export const UPDATE_HISTORY_MAX_LIMIT = 100;

type PublicUpdateRun = ReturnType<typeof toPublicUpdateRun>;

export type UpdateHistoryOptions = {
  limit?: number;
  runId?: string;
  json?: boolean;
};

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
      { key: "Run", header: "Run", minWidth: 10 },
      { key: "When", header: "When", minWidth: 20 },
      { key: "Status", header: "Status", minWidth: 9 },
      { key: "Phase", header: "Phase", minWidth: 8 },
      { key: "Trigger", header: "Trigger", minWidth: 10 },
      { key: "Target", header: "Target", minWidth: 10, flex: true },
      { key: "Reason", header: "Reason", minWidth: 12, flex: true },
    ],
    rows: runs.map((run) => ({
      Run: sanitizeTerminalText(run.runId).slice(0, 16),
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
): Promise<void> {
  const runId = opts.runId?.trim();
  if (opts.runId !== undefined && !runId) {
    throw new Error("--run must not be blank");
  }
  const limit = Math.min(
    Math.max(opts.limit ?? UPDATE_HISTORY_DEFAULT_LIMIT, 1),
    UPDATE_HISTORY_MAX_LIMIT,
  );

  await withUpdateDatabaseEngine(process.env, async () => {
    if (runId) {
      const run = getUpdateRun(runId);
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

    const runs = listUpdateRuns({ limit }).map(toPublicUpdateRun);
    if (opts.json) {
      writeRuntimeJson(runtime, { runs });
      return;
    }
    runtime.log(renderUpdateHistory(runs));
    if (runs.length >= limit && limit < UPDATE_HISTORY_MAX_LIMIT) {
      runtime.log(
        theme.muted(
          `Showing the ${limit} most recent runs; raise --limit for more (max ${UPDATE_HISTORY_MAX_LIMIT}).`,
        ),
      );
    }
  });
}
