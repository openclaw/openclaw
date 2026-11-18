import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  extractStoredAssistantText,
  stripToolMessages,
} from "../../../agents/tools/chat-history-text.js";
import { bindAgentToolGatewayRequest } from "../../../agents/tools/in-process-gateway.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import { type SubagentsCommandContext, resolveSubagentEntryForToken } from "./shared.js";

export async function handleSubagentsLogAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { readContext, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return commandReply("📜 Usage: /subagents log <id|#> [limit]");
  }

  const includeTools = restTokens.some(
    (token) => normalizeLowercaseStringOrEmpty(token) === "tools",
  );
  const limitToken = restTokens
    .slice(1)
    .find((token) => parseStrictNonNegativeInteger(token) !== undefined);
  const parsedLimit = parseStrictNonNegativeInteger(limitToken);
  const limit = parsedLimit === undefined ? 20 : Math.min(200, Math.max(1, parsedLimit));

  const targetResolution = resolveSubagentEntryForToken(readContext.list.view, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const history = await bindAgentToolGatewayRequest({ hostedOnly: true })<{
    messages: Array<unknown>;
  }>({
    method: "chat.history",
    params: { sessionKey: targetResolution.entry.childSessionKey, limit },
  });
  const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
  const filtered = includeTools ? rawMessages : stripToolMessages(rawMessages);
  const lines: string[] = [];
  for (const message of filtered as Array<{ role?: unknown; content?: unknown }>) {
    const assistant = message.role === "assistant";
    const text = extractTextFromChatContent(
      assistant ? extractStoredAssistantText(message) : message.content,
    );
    if (!text) {
      continue;
    }
    lines.push(`${assistant ? "Assistant" : "User"}: ${text}`);
  }
  const header = `📜 Subagent log: ${formatRunLabel(targetResolution.entry)}`;
  return commandReply(`${header}\n${lines.join("\n") || "(no messages)"}`);
}
