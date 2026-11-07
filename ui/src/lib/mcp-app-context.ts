import type { ContentBlock } from "@modelcontextprotocol/client";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CHAT_APP_CONTEXT_LIMITS,
  type ChatAppContextAttachment,
} from "../../../packages/gateway-protocol/src/chat-app-context.js";
import { isQuestionThumbnail } from "../../../packages/gateway-protocol/src/question-media.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import type { McpAppContextState } from "../components/mcp-app-security.ts";
export type { McpAppContextState } from "../components/mcp-app-security.ts";
export type McpAppContextEntry = {
  viewId: string;
  sessionKey: string;
  agentId?: string;
  title: string;
  state: McpAppContextState;
};

/** Ephemeral presentation of Gateway-owned attachments, scoped to the exact connection. */
const projections = new WeakMap<
  NonNullable<ApplicationGateway["snapshot"]["client"]>,
  Map<string, McpAppContextEntry>
>();
const listeners = new WeakMap<
  NonNullable<ApplicationGateway["snapshot"]["client"]>,
  Set<() => void>
>();
export function publishMcpAppContext(
  client: NonNullable<ApplicationGateway["snapshot"]["client"]>,
  entry: McpAppContextEntry,
) {
  const entries = projections.get(client) ?? new Map();
  const key = JSON.stringify([entry.sessionKey, entry.agentId, entry.viewId]);
  if (entry.state) {
    entries.set(key, entry);
  } else {
    entries.delete(key);
  }
  projections.set(client, entries);
  for (const listener of listeners.get(client) ?? []) {
    listener();
  }
}
export function readMcpAppContexts(
  client: ApplicationGateway["snapshot"]["client"],
  sessionKey: string,
  agentId?: string,
): McpAppContextEntry[] {
  return client
    ? [...(projections.get(client)?.values() ?? [])].filter(
        (entry) => entry.sessionKey === sessionKey && (!entry.agentId || entry.agentId === agentId),
      )
    : [];
}
export function subscribeMcpAppContexts(
  client: NonNullable<ApplicationGateway["snapshot"]["client"]>,
  listener: () => void,
) {
  const subscribed = listeners.get(client) ?? new Set();
  subscribed.add(listener);
  listeners.set(client, subscribed);
  return () => {
    subscribed.delete(listener);
  };
}
export function mcpAppContextItemTitle(content: ContentBlock, fallback: string): string {
  const title = content._meta?.["openai/title"];
  if (typeof title === "string" && title.trim()) {
    return title.trim();
  }
  if (content.type === "resource_link") {
    return content.title || content.name;
  }
  if (content.type === "resource") {
    return content.resource.uri;
  }
  return fallback;
}
export function mcpAppContextThumbnail(content: ContentBlock): string | null {
  const thumbnail = content._meta?.["openai/thumbnail"];
  if (isRecord(thumbnail) && "src" in thumbnail && isQuestionThumbnail(thumbnail.src)) {
    return thumbnail.src;
  }
  const icon =
    content.type === "resource_link"
      ? content.icons?.find((candidate) => isQuestionThumbnail(candidate.src))?.src
      : undefined;
  if (icon) {
    return icon;
  }
  return content.type === "image" &&
    /^image\/(png|jpeg|webp|gif)$/u.test(content.mimeType) &&
    /^[A-Za-z0-9+/]*={0,2}$/u.test(content.data)
    ? `data:${content.mimeType};base64,${content.data}`
    : null;
}

/** Freeze the visible references when Send is pressed, rather than on later delivery. */
export function captureMcpAppContext(
  client: ApplicationGateway["snapshot"]["client"],
  sessionKey: string,
  agentId?: string,
): ChatAppContextAttachment[] | undefined {
  const entries = readMcpAppContexts(client, sessionKey, agentId);
  const items: ChatAppContextAttachment[] = [];
  for (const entry of entries) {
    for (const content of entry.state?.content ?? []) {
      const item: ChatAppContextAttachment = {
        title: mcpAppContextItemTitle(content, entry.title).slice(0, CHAT_APP_CONTEXT_LIMITS.title),
      };
      if (content.type === "resource_link") {
        item.uri = content.uri.slice(0, CHAT_APP_CONTEXT_LIMITS.uri);
        if (content.description) {
          item.description = content.description.slice(0, CHAT_APP_CONTEXT_LIMITS.description);
        }
      }
      const icon = mcpAppContextThumbnail(content);
      if (icon && icon.length <= CHAT_APP_CONTEXT_LIMITS.icon) {
        item.icon = icon;
      }
      items.push(item);
      if (items.length === CHAT_APP_CONTEXT_LIMITS.items) {
        return items;
      }
    }
    if (entry.state?.structuredContent) {
      items.push({ title: entry.title.slice(0, CHAT_APP_CONTEXT_LIMITS.title) });
      if (items.length === CHAT_APP_CONTEXT_LIMITS.items) {
        return items;
      }
    }
  }
  return items.length ? items : undefined;
}
