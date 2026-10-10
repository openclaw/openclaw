import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import { resolveCommandSourceSessionKey } from "./command-source-session-key.js";
import { buildSubagentsHelp } from "./commands-subagents/shared.js";
import type { CommandHandler } from "./commands-types.js";

export const handleSubagentsCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/subagents",
    match: (
      body,
    ): { action: "agents" | "list" | "info" | "log" | "help"; restTokens: string[] } | null => {
      const rest = matchCommandPrefix(body, "/subagents");
      if (rest !== null) {
        const [rawAction = "list", ...restTokens] = rest.split(/\s+/).filter(Boolean);
        const action = rawAction.toLowerCase();
        return {
          action: action === "list" || action === "info" || action === "log" ? action : "help",
          restTokens,
        };
      }
      return matchCommandPrefix(body, "/agents") === null
        ? null
        : { action: "agents", restTokens: [] };
    },
    silentUnauthorized: true,
  },
  async (params, { action, restTokens }) => {
    if (action === "help") {
      return commandReply(buildSubagentsHelp());
    }

    const requesterKey = resolveCommandSourceSessionKey(params);
    if (!requesterKey) {
      return commandReply("⚠️ Missing session key.");
    }

    const actionHandler =
      action === "agents"
        ? (await import("./commands-subagents/action-agents.js")).handleSubagentsAgentsAction
        : action === "list"
          ? (await import("./commands-subagents/action-list.js")).handleSubagentsListAction
          : action === "info"
            ? (await import("./commands-subagents/action-info.js")).handleSubagentsInfoAction
            : (await import("./commands-subagents/action-log.js")).handleSubagentsLogAction;
    const { buildControlledSubagentRunsReadContext } =
      await import("../../agents/subagents/registry/subagent-control-scope.js");
    const readContext = await buildControlledSubagentRunsReadContext(
      requesterKey,
      params.agentId,
      params.cfg,
    );

    return await actionHandler({
      params,
      requesterKey,
      readContext,
      restTokens,
    });
  },
);
