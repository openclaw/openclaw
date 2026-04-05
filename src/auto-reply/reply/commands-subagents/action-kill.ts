import type { CommandHandlerResult } from "../commands-types.js";
import type { SubagentsCommandContext } from "../commands-subagents-types.js";
import {
  COMMAND,
  resolveCommandSubagentController,
  stopWithText,
} from "./core.js";
import { resolveSubagentEntryForToken } from "../commands-subagents-read.js";

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
    const controller = await resolveCommandSubagentController(params, requesterKey);
    const { killAllControlledSubagentRuns } = await import("../../../agents/subagent-control.js");
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

  const controller = await resolveCommandSubagentController(params, requesterKey);
  const { killControlledSubagentRun } = await import("../../../agents/subagent-control.js");
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
