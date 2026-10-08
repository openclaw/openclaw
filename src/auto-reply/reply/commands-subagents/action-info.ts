import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { sanitizeRunStatusText } from "../../../agents/run-status-text.js";
import { resolveSubagentDisplayStatus } from "../../../agents/subagents/registry/subagent-session-metrics.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import { formatTimeAgo } from "../../../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import { resolveSubagentEntryForToken, type SubagentsCommandContext } from "./shared.js";

function formatTimestampWithAge(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  const timestamp = timestampMsToIsoString(valueMs);
  if (!timestamp) {
    return "n/a";
  }
  return `${timestamp} (${formatTimeAgo(Date.now() - valueMs, { fallback: "n/a" })})`;
}

export function handleSubagentsInfoAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, readContext, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return commandReply("ℹ️ Usage: /subagents info <id|#>");
  }

  const targetResolution = resolveSubagentEntryForToken(readContext.list.view, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const run = targetResolution.entry;
  const sessionEntry = loadSessionEntryReadOnly({
    storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: parseAgentSessionKey(run.childSessionKey)?.agentId,
    }),
    sessionKey: run.childSessionKey,
    clone: false,
  });
  const runtime =
    run.execution.startedAt && Number.isFinite(run.execution.startedAt)
      ? (formatDurationCompact((run.execution.endedAt ?? Date.now()) - run.execution.startedAt) ??
        "n/a")
      : "n/a";
  const outcomeError = sanitizeRunStatusText(run.execution.outcome?.error, { errorContext: true });
  const outcome = run.execution.outcome
    ? `${run.execution.outcome.status}${outcomeError ? ` (${outcomeError})` : ""}`
    : "n/a";
  const taskText = sanitizeRunStatusText(run.task) || "n/a";
  const progressText = sanitizeRunStatusText(run.completion?.resultText);
  const taskSummaryText = sanitizeRunStatusText(
    run.delivery?.lastError ?? run.delivery?.discardedPayloadSummary?.lastError,
    { errorContext: true },
  );

  const lines = [
    "ℹ️ Subagent info",
    `Status: ${resolveSubagentDisplayStatus(run, readContext.list.pendingDescendants.get(run.childSessionKey) ?? 0)}`,
    `Label: ${formatRunLabel(run)}`,
    `Task: ${taskText}`,
    `Run: ${run.runId}`,
    `Session: ${run.childSessionKey}`,
    `SessionId: ${sessionEntry?.sessionId ?? "n/a"}`,
    `Runtime: ${runtime}`,
    `Created: ${formatTimestampWithAge(run.createdAt)}`,
    `Started: ${formatTimestampWithAge(run.execution.startedAt)}`,
    `Ended: ${formatTimestampWithAge(run.execution.endedAt)}`,
    `Cleanup: ${run.cleanup}`,
    run.archiveAtMs ? `Archive: ${formatTimestampWithAge(run.archiveAtMs)}` : undefined,
    run.cleanupHandled ? "Cleanup handled: yes" : undefined,
    `Outcome: ${outcome}`,
    progressText ? `Progress: ${progressText}` : undefined,
    taskSummaryText ? `Task summary: ${taskSummaryText}` : undefined,
    outcomeError ? `Task error: ${outcomeError}` : undefined,
    run.delivery ? `Delivery: ${run.delivery.status}` : undefined,
    run.delivery?.discardReason ? `Delivery disposition: ${run.delivery.discardReason}` : undefined,
    run.delivery?.discardedAt
      ? `Delivery retired: ${formatTimestampWithAge(run.delivery.discardedAt)}`
      : undefined,
  ].filter(Boolean);

  return commandReply(lines.join("\n"));
}
