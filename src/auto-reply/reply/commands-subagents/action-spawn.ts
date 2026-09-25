// Starts a user-requested subagent in a new thread or topic of the current conversation.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { CHILD_THREAD_UNAVAILABLE_ERROR } from "../../../agents/subagents/spawn/subagent-spawn-thread-binding.js";
import { spawnSubagentDirect } from "../../../agents/subagents/spawn/subagent-spawn.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import type { SubagentsCommandContext } from "./shared.js";

export const SUBAGENTS_SPAWN_USAGE = "Usage: /subagents spawn --thread [--agent <id>] <task>";

export async function handleSubagentsSpawnAction(
  ctx: Pick<SubagentsCommandContext, "params" | "requesterKey" | "restTokens">,
): Promise<CommandHandlerResult> {
  const { params, requesterKey, restTokens } = ctx;
  let thread = false;
  let agentId: string | undefined;
  const taskParts: string[] = [];
  const tokens = restTokens.values();
  for (const token of tokens) {
    if (token === "--thread") {
      thread = true;
    } else if (token === "--agent") {
      agentId = tokens.next().value;
    } else {
      taskParts.push(token);
    }
  }
  const task = taskParts.join(" ").trim();
  if (!thread || !task) {
    return commandReply(`⚠️ ${SUBAGENTS_SPAWN_USAGE}`);
  }
  // A direct chat has only its main conversation; binding it would take the chat over.
  if (params.ctx.ChatType === "direct") {
    return commandReply(`⚠️ ${CHILD_THREAD_UNAVAILABLE_ERROR} Nothing was started.`);
  }

  const result = await spawnSubagentDirect(
    {
      task,
      agentId,
      label: task.slice(0, 60),
      cleanup: "keep",
      childThread: { boundBy: normalizeOptionalString(params.command.senderId) ?? "unknown" },
    },
    {
      // Rechecked before each spawn effect, including the thread bind.
      assertActive: params.command.assertOwnerCurrent,
      agentSessionKey: requesterKey,
      agentChannel: params.ctx.OriginatingChannel ?? params.command.channel,
      agentAccountId: params.ctx.AccountId,
      agentTo:
        normalizeOptionalString(params.ctx.OriginatingTo) ??
        normalizeOptionalString(params.command.to) ??
        normalizeOptionalString(params.ctx.To),
      agentThreadId: params.ctx.MessageThreadId,
    },
  );
  if (result.status === "accepted") {
    return commandReply(`Started a subagent in a new thread. Talk to it there.`);
  }
  return commandReply(
    `⚠️ ${result.error ?? `Subagent spawn ${result.status}.`} Nothing was started.`,
  );
}
