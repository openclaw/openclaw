import { getThreadBindingManager } from "../../../discord/monitor/thread-bindings.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel, sortSubagentRuns } from "../subagents-utils.js";
import {
  type SubagentsCommandContext,
  isDiscordSurface,
  resolveDiscordAccountId,
  stopWithText,
} from "./shared.js";

export function handleSubagentsAgentsAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, requesterKey, runs } = ctx;
  const isDiscord = isDiscordSurface(params);
  const accountId = isDiscord ? resolveDiscordAccountId(params) : undefined;
  const threadBindings = accountId ? getThreadBindingManager(accountId) : null;
  const visibleRuns = sortSubagentRuns(runs).filter((entry) => {
    if (!entry.endedAt) {
      return true;
    }
    return Boolean(threadBindings?.listBySessionKey(entry.childSessionKey)[0]);
  });

  const lines = ["agents:", "-----"];
  if (visibleRuns.length === 0) {
    lines.push("(none)");
  } else {
    let index = 1;
    for (const entry of visibleRuns) {
      const threadBinding = threadBindings?.listBySessionKey(entry.childSessionKey)[0];
      const bindingText = threadBinding
        ? `thread:${threadBinding.threadId}`
        : isDiscord
          ? "unbound"
          : "bindings available on discord";
      lines.push(`${index}. ${formatRunLabel(entry)} (${bindingText})`);
      index += 1;
    }
  }

  if (threadBindings) {
    const acpBindings = threadBindings
      .listBindings()
      .filter((entry) => entry.targetKind === "acp" && entry.targetSessionKey === requesterKey);
    if (acpBindings.length > 0) {
      lines.push("", "acp/session bindings:", "-----");
      for (const binding of acpBindings) {
        lines.push(
          `- ${binding.label ?? binding.targetSessionKey} (thread:${binding.threadId}, session:${binding.targetSessionKey})`,
        );
      }
    }
  }

  return stopWithText(lines.join("\n"));
}
