import { loadSessionStore, resolveStorePath } from "../../../config/sessions.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { sortSubagentRuns } from "../subagents-utils.js";
import {
  type SessionStoreCache,
  type SubagentsCommandContext,
  RECENT_WINDOW_MINUTES,
  formatSubagentListLine,
  loadSubagentSessionEntry,
  stopWithText,
} from "./shared.js";

export function handleSubagentsListAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, runs } = ctx;
  const sorted = sortSubagentRuns(runs);
  const now = Date.now();
  const recentCutoff = now - RECENT_WINDOW_MINUTES * 60_000;
  const storeCache: SessionStoreCache = new Map();
  let index = 1;

  const mapRuns = (entries: typeof runs, runtimeMs: (entry: (typeof runs)[number]) => number) =>
    entries.map((entry) => {
      const { entry: sessionEntry } = loadSubagentSessionEntry(
        params,
        entry.childSessionKey,
        {
          loadSessionStore,
          resolveStorePath,
        },
        storeCache,
      );
      const line = formatSubagentListLine({
        entry,
        index,
        runtimeMs: runtimeMs(entry),
        sessionEntry,
      });
      index += 1;
      return line;
    });

  const activeEntries = sorted.filter((entry) => !entry.endedAt);
  const activeLines = mapRuns(activeEntries, (entry) => now - (entry.startedAt ?? entry.createdAt));
  const recentEntries = sorted.filter(
    (entry) => !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff,
  );
  const recentLines = mapRuns(
    recentEntries,
    (entry) => (entry.endedAt ?? now) - (entry.startedAt ?? entry.createdAt),
  );

  const lines = ["active subagents:", "-----"];
  if (activeLines.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(activeLines.join("\n"));
  }
  lines.push("", `recent subagents (last ${RECENT_WINDOW_MINUTES}m):`, "-----");
  if (recentLines.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(recentLines.join("\n"));
  }

  return stopWithText(lines.join("\n"));
}
