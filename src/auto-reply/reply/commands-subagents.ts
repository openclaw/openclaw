import { logVerbose } from "../../globals.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { CommandHandler } from "./commands-types.js";
import {
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  stopWithText,
} from "./commands-subagents/core.js";
import { extractMessageText } from "./commands-subagents-text.js";

export { extractMessageText };

function sortSubagentRuns(runs: SubagentRunRecord[]) {
  return [...runs].toSorted((a, b) => {
    const aTime = a.startedAt ?? a.createdAt ?? 0;
    const bTime = b.startedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });
}

async function listControlledSubagentRunsLight(
  controllerSessionKey: string,
): Promise<SubagentRunRecord[]> {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }

  const { listSubagentRunsForController, getLatestSubagentRunByChildSessionKey } = await import(
    "../../agents/subagent-registry-read.js"
  );

  const filtered: SubagentRunRecord[] = [];
  for (const entry of sortSubagentRuns(listSubagentRunsForController(key))) {
    const latest = getLatestSubagentRunByChildSessionKey(entry.childSessionKey);
    const latestControllerSessionKey =
      latest?.controllerSessionKey?.trim() || latest?.requesterSessionKey?.trim();
    if (!latest || latest.runId !== entry.runId || latestControllerSessionKey !== key) {
      continue;
    }
    filtered.push(entry);
  }

  return filtered;
}

export const handleSubagentsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;
  const handledPrefix = resolveHandledPrefix(normalized);
  if (!handledPrefix) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring ${handledPrefix} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice(handledPrefix.length).trim();
  const restTokens = rest.split(/\s+/).filter(Boolean);
  const action = resolveSubagentsAction({ handledPrefix, restTokens });
  if (!action) {
    const { handleSubagentsHelpAction } = await import("./commands-subagents/action-help.js");
    return handleSubagentsHelpAction();
  }

  const requesterKey =
    action === "spawn"
      ? resolveRequesterSessionKey(params, {
          preferCommandTarget: true,
        })
      : resolveRequesterSessionKey(params);
  if (!requesterKey) {
    return stopWithText("⚠️ Missing session key.");
  }

  const ctx = {
    params,
    handledPrefix,
    requesterKey,
    runs: await listControlledSubagentRunsLight(requesterKey),
    restTokens,
  };

  switch (action) {
    case "help": {
      const { handleSubagentsHelpAction } = await import("./commands-subagents/action-help.js");
      return handleSubagentsHelpAction();
    }
    case "agents": {
      const { handleSubagentsAgentsAction } = await import("./commands-subagents/action-agents.js");
      return handleSubagentsAgentsAction(ctx);
    }
    case "focus": {
      const { handleSubagentsFocusAction } = await import("./commands-subagents/action-focus.js");
      return await handleSubagentsFocusAction(ctx);
    }
    case "unfocus": {
      const { handleSubagentsUnfocusAction } = await import("./commands-subagents/action-unfocus.js");
      return await handleSubagentsUnfocusAction(ctx);
    }
    case "list": {
      const { handleSubagentsListAction } = await import("./commands-subagents/action-list.js");
      return handleSubagentsListAction(ctx);
    }
    case "kill": {
      const { handleSubagentsKillAction } = await import("./commands-subagents/action-kill.js");
      return await handleSubagentsKillAction(ctx);
    }
    case "info": {
      const { handleSubagentsInfoAction } = await import("./commands-subagents/action-info.js");
      return handleSubagentsInfoAction(ctx);
    }
    case "log": {
      const { handleSubagentsLogAction } = await import("./commands-subagents/action-log.js");
      return await handleSubagentsLogAction(ctx);
    }
    case "send": {
      const { handleSubagentsSendAction } = await import("./commands-subagents/action-send.js");
      return await handleSubagentsSendAction(ctx, false);
    }
    case "steer": {
      const { handleSubagentsSendAction } = await import("./commands-subagents/action-send.js");
      return await handleSubagentsSendAction(ctx, true);
    }
    case "spawn": {
      const { handleSubagentsSpawnAction } = await import("./commands-subagents/action-spawn.js");
      return await handleSubagentsSpawnAction(ctx);
    }
    default: {
      const { handleSubagentsHelpAction } = await import("./commands-subagents/action-help.js");
      return handleSubagentsHelpAction();
    }
  }
};
