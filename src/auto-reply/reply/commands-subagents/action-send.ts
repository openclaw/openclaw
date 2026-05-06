import {
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "../commands-subagents-control.runtime.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import {
  type SubagentsCommandContext,
  COMMAND,
  resolveCommandSubagentController,
  resolveSubagentEntryForToken,
  stopWithText,
} from "./shared.js";

/**
 * When steer is requested without an explicit target, attempt to auto-select the
 * sole active subagent so `/steer <message>` works without specifying an id.
 */
function tryAutoSelectSteerTarget(
  runs: SubagentRunRecord[],
): SubagentRunRecord | undefined {
  const active = runs.filter((r) => !r.endedAt);
  if (active.length === 1) {
    return active[0];
  }
  return undefined;
}

async function steerAutoSelected(
  ctx: SubagentsCommandContext,
  entry: SubagentRunRecord,
  fullMessage: string,
): Promise<CommandHandlerResult> {
  const controller = resolveCommandSubagentController(ctx.params, ctx.requesterKey);
  const result = await steerControlledSubagentRun({
    cfg: ctx.params.cfg,
    controller,
    entry,
    message: fullMessage,
  });
  if (result.status === "accepted") {
    return stopWithText(
      `steered ${formatRunLabel(entry)} (run ${result.runId.slice(0, 8)}).`,
    );
  }
  if (result.status === "done" && result.text) {
    return stopWithText(result.text);
  }
  if (result.status === "error") {
    return stopWithText(`send failed: ${result.error ?? "error"}`);
  }
  return stopWithText(`⚠️ ${result.error ?? "send failed"}`);
}

export async function handleSubagentsSendAction(
  ctx: SubagentsCommandContext,
  steerRequested: boolean,
): Promise<CommandHandlerResult> {
  const { params, handledPrefix, runs, restTokens } = ctx;
  const target = restTokens[0];
  const message = restTokens.slice(1).join(" ").trim();
  if (!target || !message) {
    // For /steer, allow omitting the target when there is exactly one active subagent.
    if (steerRequested && target) {
      const autoEntry = tryAutoSelectSteerTarget(runs);
      if (autoEntry) {
        return steerAutoSelected(ctx, autoEntry, restTokens.join(" ").trim());
      }
    }
    return stopWithText(
      steerRequested
        ? handledPrefix === COMMAND
          ? "Usage: /subagents steer <id|#> <message>"
          : `Usage: ${handledPrefix} <id|#> <message>`
        : "Usage: /subagents send <id|#> <message>",
    );
  }

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  // For /steer, if target resolution fails, try auto-selecting the sole active subagent
  // and treat the entire input (including the failed target token) as the message.
  if ("reply" in targetResolution && steerRequested) {
    const autoEntry = tryAutoSelectSteerTarget(runs);
    if (autoEntry) {
      return steerAutoSelected(ctx, autoEntry, restTokens.join(" ").trim());
    }
  }
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const controller = resolveCommandSubagentController(params, ctx.requesterKey);

  if (steerRequested) {
    const result = await steerControlledSubagentRun({
      cfg: params.cfg,
      controller,
      entry: targetResolution.entry,
      message,
    });
    if (result.status === "accepted") {
      return stopWithText(
        `steered ${formatRunLabel(targetResolution.entry)} (run ${result.runId.slice(0, 8)}).`,
      );
    }
    if (result.status === "done" && result.text) {
      return stopWithText(result.text);
    }
    if (result.status === "error") {
      return stopWithText(`send failed: ${result.error ?? "error"}`);
    }
    return stopWithText(`⚠️ ${result.error ?? "send failed"}`);
  }

  const result = await sendControlledSubagentMessage({
    cfg: params.cfg,
    controller,
    entry: targetResolution.entry,
    message,
  });
  if (result.status === "timeout") {
    return stopWithText(`⏳ Subagent still running (run ${result.runId.slice(0, 8)}).`);
  }
  if (result.status === "error") {
    return stopWithText(`⚠️ Subagent error: ${result.error} (run ${result.runId.slice(0, 8)}).`);
  }
  if (result.status === "forbidden") {
    return stopWithText(`⚠️ ${result.error ?? "send failed"}`);
  }
  if (result.status === "done") {
    return stopWithText(result.text);
  }
  return stopWithText(
    result.replyText ??
      `✅ Sent to ${formatRunLabel(targetResolution.entry)} (run ${result.runId.slice(0, 8)}).`,
  );
}
