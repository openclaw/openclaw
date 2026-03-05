import { loadSessionStore, resolveStorePath } from "../../../config/sessions.js";
import { formatDurationCompact } from "../../../shared/subagents-format.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  type SubagentsCommandContext,
  formatTimestampWithAge,
  loadSubagentSessionEntry,
  resolveDisplayStatus,
  resolveSubagentEntryForToken,
  stopWithText,
} from "./shared.js";

export function handleSubagentsInfoAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, runs, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return stopWithText("ℹ️ Usage: /subagents info <id|#>");
  }

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const run = targetResolution.entry;
  const { entry: sessionEntry } = loadSubagentSessionEntry(params, run.childSessionKey, {
    loadSessionStore,
    resolveStorePath,
  });
  const runtime =
    run.startedAt && Number.isFinite(run.startedAt)
      ? (formatDurationCompact((run.endedAt ?? Date.now()) - run.startedAt) ?? "n/a")
      : "n/a";
  const outcome = run.outcome
    ? `${run.outcome.status}${run.outcome.error ? ` (${run.outcome.error})` : ""}`
    : "n/a";

  const lines = [
    "ℹ️ Subagent info",
    `Status: ${resolveDisplayStatus(run)}`,
    `Label: ${formatRunLabel(run)}`,
    `Task: ${run.task}`,
    `Run: ${run.runId}`,
    `Session: ${run.childSessionKey}`,
    `SessionId: ${sessionEntry?.sessionId ?? "n/a"}`,
    `Transcript: ${sessionEntry?.sessionFile ?? "n/a"}`,
    `Runtime: ${runtime}`,
    `Created: ${formatTimestampWithAge(run.createdAt)}`,
    `Started: ${formatTimestampWithAge(run.startedAt)}`,
    `Ended: ${formatTimestampWithAge(run.endedAt)}`,
    `Cleanup: ${run.cleanup}`,
    run.archiveAtMs ? `Archive: ${formatTimestampWithAge(run.archiveAtMs)}` : undefined,
    run.cleanupHandled ? "Cleanup handled: yes" : undefined,
    `Outcome: ${outcome}`,
  ].filter(Boolean);

  return stopWithText(lines.join("\n"));
}
