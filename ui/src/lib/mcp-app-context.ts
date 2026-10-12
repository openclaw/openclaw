import type { ContentBlock } from "@modelcontextprotocol/client";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  agentId: string,
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
  return content.type === "image" &&
    /^image\/(png|jpeg|webp|gif)$/u.test(content.mimeType) &&
    /^[A-Za-z0-9+/]*={0,2}$/u.test(content.data)
    ? `data:${content.mimeType};base64,${content.data}`
    : null;
}
