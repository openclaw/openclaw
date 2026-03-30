import {
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "../../../agents/subagent-control.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  type SubagentsCommandContext,
  COMMAND,
  resolveCommandSubagentController,
  resolveSubagentEntryForToken,
  stopWithText,
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
