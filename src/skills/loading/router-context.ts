import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SkillRouteContext, SkillRouteContextMessage } from "./router-types.js";

const MAX_RECENT_ROUTE_CONTEXT_MESSAGES = 6;

function normalizeRouteText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractRouteMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return normalizeRouteText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }
  return normalizeRouteText(parts.join(" "));
}

function collectRecentRouteContextMessages(params: {
  messages: AgentMessage[];
}): SkillRouteContextMessage[] {
  const collected: SkillRouteContextMessage[] = [];

  for (let index = params.messages.length - 1; index >= 0; index--) {
    const message = params.messages[index];
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = extractRouteMessageText(message);
    if (!text) {
      continue;
    }

    if (collected.length >= MAX_RECENT_ROUTE_CONTEXT_MESSAGES) {
      break;
    }

    collected.unshift({ role: message.role, text });
  }

  return collected;
}

export function buildSkillRouteContext(params: {
  query?: string;
  recentMessages?: AgentMessage[];
}): SkillRouteContext {
  const currentQuery = normalizeRouteText(params.query ?? "");
  const recentMessages =
    currentQuery && params.recentMessages?.length
      ? collectRecentRouteContextMessages({
          messages: params.recentMessages,
        })
      : [];
  return { recentMessages };
}
