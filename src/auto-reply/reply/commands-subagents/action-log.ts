import { callGateway } from "../../../gateway/call.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  type ChatMessage,
  type SubagentsCommandContext,
  formatLogLines,
  resolveSubagentEntryForToken,
  stopWithText,
  stripToolMessages,
} from "./shared.js";

export async function handleSubagentsLogAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { runs, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return stopWithText("📜 Usage: /subagents log <id|#> [limit]");
  }

  const includeTools = restTokens.some((token) => token.toLowerCase() === "tools");
  const limitToken = restTokens.find((token) => /^\d+$/.test(token));
  const limit = limitToken ? Math.min(200, Math.max(1, Number.parseInt(limitToken, 10))) : 20;

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const history = await callGateway<{ messages: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey: targetResolution.entry.childSessionKey, limit },
  });
  const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
  const filtered = includeTools ? rawMessages : stripToolMessages(rawMessages);
  const lines = formatLogLines(filtered as ChatMessage[]);
  const header = `📜 Subagent log: ${formatRunLabel(targetResolution.entry)}`;
  if (lines.length === 0) {
    return stopWithText(`${header}\n(no messages)`);
  }
  return stopWithText([header, ...lines].join("\n"));
}
