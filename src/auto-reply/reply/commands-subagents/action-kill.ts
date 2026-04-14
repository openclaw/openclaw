import {
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
} from "../commands-subagents-control.runtime.js";
import type { CommandHandlerResult } from "../commands-types.js";
import {
  type SubagentsCommandContext,
  COMMAND,
  COMMAND_SPAWN,
  resolveCommandSubagentController,
  resolveExplicitSubagentEntryForToken,
  resolveImplicitSubagentEntryForSpawnCommand,
  resolveSubagentTarget,
  resolveSubagentEntryForToken,
  stopWithText,
} from "./shared.js";

export async function handleSubagentsKillAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, handledPrefix, requesterKey, runs, restTokens } = ctx;
  const target = restTokens[0];
  if (!target && handledPrefix !== COMMAND_SPAWN) {
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

  const explicitTarget = resolveExplicitSubagentEntryForToken(runs, target);
  if (handledPrefix === COMMAND_SPAWN && target && !explicitTarget) {
    const resolved = resolveSubagentTarget(runs, target);
    return stopWithText(`⚠️ ${resolved.error ?? `Unknown subagent id: ${target}`}`);
  }

  const targetResolution =
    handledPrefix === COMMAND_SPAWN
      ? (explicitTarget ?? resolveImplicitSubagentEntryForSpawnCommand(ctx))
      : resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
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
