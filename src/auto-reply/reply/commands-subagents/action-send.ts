import {
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
} from "../commands-subagents-control.runtime.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  type SubagentsCommandContext,
  COMMAND,
  COMMAND_SPAWN,
  resolveCommandSubagentController,
  resolveExplicitSubagentEntryForToken,
  resolveImplicitSubagentEntryForSpawnCommand,
  resolveSubagentEntryForToken,
  stopWithText,
} from "./shared.js";

export async function handleSubagentsSendAction(
  ctx: SubagentsCommandContext,
  steerRequested: boolean,
): Promise<CommandHandlerResult> {
  const { params, handledPrefix, runs, restTokens } = ctx;
  const firstToken = restTokens[0];
  const explicitTarget =
    handledPrefix === COMMAND_SPAWN ? resolveExplicitSubagentEntryForToken(runs, firstToken) : null;
  const messageStartIndex = explicitTarget ? 1 : handledPrefix === COMMAND_SPAWN ? 0 : 1;
  const message = restTokens.slice(messageStartIndex).join(" ").trim();
  if ((!firstToken && handledPrefix !== COMMAND_SPAWN) || !message) {
    return stopWithText(
      steerRequested
        ? handledPrefix === COMMAND
          ? "Usage: /subagents steer <id|#> <message>"
          : handledPrefix === COMMAND_SPAWN
            ? "Usage: /spawn steer [id|#] <message>"
            : `Usage: ${handledPrefix} <id|#> <message>`
        : handledPrefix === COMMAND_SPAWN
          ? "Usage: /spawn send [id|#] <message>"
          : "Usage: /subagents send <id|#> <message>",
    );
  }

  const targetResolution =
    handledPrefix === COMMAND_SPAWN
      ? (explicitTarget ?? resolveImplicitSubagentEntryForSpawnCommand(ctx))
      : resolveSubagentEntryForToken(runs, firstToken);
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
