import {
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
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

export async function handleSubagentsKillAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, handledPrefix, requesterKey, runs, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return stopWithText(
      handledPrefix === COMMAND ? "Usage: /subagents kill <id|#|all>" : "Usage: /kill <id|#|all>",
    );
  }

  if (target === "all" || target === "*") {
    const controller = resolveCommandSubagentController(params, requesterKey);
    const result = await killAllControlledSubagentRuns({
      cfg: params.cfg,
      controller,
      runs,
    });
    if (result.status === "forbidden") {
      return stopWithText(`⚠️ ${result.error}`);
    }
    if (result.killed > 0) {
      return { shouldContinue: false };
    }
    return { shouldContinue: false };
  }

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }
  if (targetResolution.entry.endedAt) {
    return stopWithText(`${formatRunLabel(targetResolution.entry)} is already finished.`);
  }

  const controller = resolveCommandSubagentController(params, requesterKey);
  const result = await killControlledSubagentRun({
    cfg: params.cfg,
    controller,
    entry: targetResolution.entry,
  });
  if (result.status === "forbidden") {
    return stopWithText(`⚠️ ${result.error}`);
  }
  if (result.status === "done") {
    return stopWithText(result.text);
  }
  return { shouldContinue: false };
}
