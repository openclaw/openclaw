import crypto from "node:crypto";
import { AGENT_LANE_SUBAGENT } from "../../../agents/lanes.js";
import { abortEmbeddedPiRun } from "../../../agents/pi-embedded.js";
import {
  clearSubagentRunSteerRestart,
  replaceSubagentRunAfterSteer,
  markSubagentRunForSteerRestart,
} from "../../../agents/subagent-registry.js";
import { loadSessionStore, resolveStorePath } from "../../../config/sessions.js";
import { callGateway } from "../../../gateway/call.js";
import { logVerbose } from "../../../globals.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { clearSessionQueues } from "../queue.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  type SubagentsCommandContext,
  COMMAND,
  STEER_ABORT_SETTLE_TIMEOUT_MS,
  extractAssistantText,
  loadSubagentSessionEntry,
  resolveSubagentEntryForToken,
  stopWithText,
  stripToolMessages,
} from "./shared.js";

export async function handleSubagentsSendAction(
  ctx: SubagentsCommandContext,
  steerRequested: boolean,
): Promise<CommandHandlerResult> {
  const { params, handledPrefix, runs, restTokens } = ctx;
  const target = restTokens[0];
  const message = restTokens.slice(1).join(" ").trim();
  if (!target || !message) {
    return stopWithText(
      steerRequested
        ? handledPrefix === COMMAND
          ? "Usage: /subagents steer <id|#> <message>"
          : `Usage: ${handledPrefix} <id|#> <message>`
        : "Usage: /subagents send <id|#> <message>",
    );
  }

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }
  if (steerRequested && targetResolution.entry.endedAt) {
    return stopWithText(`${formatRunLabel(targetResolution.entry)} is already finished.`);
  }

  const { entry: targetSessionEntry } = loadSubagentSessionEntry(
    params,
    targetResolution.entry.childSessionKey,
    {
      loadSessionStore,
      resolveStorePath,
    },
  );
  const targetSessionId =
    typeof targetSessionEntry?.sessionId === "string" && targetSessionEntry.sessionId.trim()
      ? targetSessionEntry.sessionId.trim()
      : undefined;

  if (steerRequested) {
    markSubagentRunForSteerRestart(targetResolution.entry.runId);

    if (targetSessionId) {
      abortEmbeddedPiRun(targetSessionId);
    }

    const cleared = clearSessionQueues([targetResolution.entry.childSessionKey, targetSessionId]);
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `subagents steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }

    try {
      await callGateway({
        method: "agent.wait",
        params: {
          runId: targetResolution.entry.runId,
          timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
        },
        timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2_000,
      });
    } catch {
      // Continue even if wait fails; steer should still be attempted.
    }
  }

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message,
        sessionKey: targetResolution.entry.childSessionKey,
        sessionId: targetSessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    const responseRunId = typeof response?.runId === "string" ? response.runId : undefined;
    if (responseRunId) {
      runId = responseRunId;
    }
  } catch (err) {
    if (steerRequested) {
      clearSubagentRunSteerRestart(targetResolution.entry.runId);
    }
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return stopWithText(`send failed: ${messageText}`);
  }

  if (steerRequested) {
    replaceSubagentRunAfterSteer({
      previousRunId: targetResolution.entry.runId,
      nextRunId: runId,
      fallback: targetResolution.entry,
      runTimeoutSeconds: targetResolution.entry.runTimeoutSeconds ?? 0,
    });
    return stopWithText(
      `steered ${formatRunLabel(targetResolution.entry)} (run ${runId.slice(0, 8)}).`,
    );
  }

  const waitMs = 30_000;
  const wait = await callGateway<{ status?: string; error?: string }>({
    method: "agent.wait",
    params: { runId, timeoutMs: waitMs },
    timeoutMs: waitMs + 2000,
  });
  if (wait?.status === "timeout") {
    return stopWithText(`⏳ Subagent still running (run ${runId.slice(0, 8)}).`);
  }
  if (wait?.status === "error") {
    const waitError = typeof wait.error === "string" ? wait.error : "unknown error";
    return stopWithText(`⚠️ Subagent error: ${waitError} (run ${runId.slice(0, 8)}).`);
  }

  const history = await callGateway<{ messages: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey: targetResolution.entry.childSessionKey, limit: 50 },
  });
  const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
  const replyText = last ? extractAssistantText(last) : undefined;
  return stopWithText(
    replyText ?? `✅ Sent to ${formatRunLabel(targetResolution.entry)} (run ${runId.slice(0, 8)}).`,
  );
}
