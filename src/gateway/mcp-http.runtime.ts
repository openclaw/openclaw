import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildMcpToolSchema,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const TOOL_CACHE_TTL_MS = 30_000;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

type CachedScopedTools = {
  /** Agent resolved for the scoped loopback request, if any. */
  agentId: string | undefined;
  /** Executable tools after loopback scoping and native-tool exclusion. */
  tools: McpLoopbackTool[];
  /** MCP schema derived from the same tools so list/call stay in sync. */
  toolSchema: McpToolSchemaEntry[];
  /** Config object identity used to invalidate cache entries after reloads. */
  configRef: OpenClawConfig;
  /** Cache write timestamp used for short TTL pruning. */
  time: number;
};

export function resolveMcpLoopbackScopedTools(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  messageProvider: string | undefined;
  currentChannelId: string | undefined;
  currentThreadTs: string | undefined;
  currentMessageId: string | number | undefined;
  accountId: string | undefined;
  inboundEventKind: InboundEventKind | undefined;
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  senderIsOwner: boolean | undefined;
}): { agentId: string | undefined; tools: McpLoopbackTool[] } {
  const scoped = resolveGatewayScopedTools({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    accountId: params.accountId,
    inboundEventKind: params.inboundEventKind,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    senderIsOwner: params.senderIsOwner,
    surface: "loopback",
    excludeToolNames: NATIVE_TOOL_EXCLUDE,
  });
  return {
    agentId: scoped.agentId,
    tools: scoped.tools,
  };
}

export class McpLoopbackToolCache {
  #entries = new Map<string, CachedScopedTools>();

  resolve(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    messageProvider: string | undefined;
    currentChannelId: string | undefined;
    currentThreadTs: string | undefined;
    currentMessageId: string | number | undefined;
    accountId: string | undefined;
    inboundEventKind: InboundEventKind | undefined;
    sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
    senderIsOwner: boolean | undefined;
  }): CachedScopedTools {
    // The scoped tool set depends on conversation and sender context; keep the
    // key explicit so loopback calls cannot reuse tools across route/account boundaries.
    const cacheKey = [
      params.sessionKey,
      params.messageProvider ?? "",
      params.currentChannelId ?? "",
      params.currentThreadTs ?? "",
      params.currentMessageId != null ? String(params.currentMessageId) : "",
      params.accountId ?? "",
      params.inboundEventKind ?? "",
      params.sourceReplyDeliveryMode ?? "",
      params.senderIsOwner === true ? "owner" : "non-owner",
    ].join("\u0000");
    const now = Date.now();
    const cached = this.#entries.get(cacheKey);
    // Config snapshots are process-stable between reloads; reference equality
    // avoids hashing the full config on the MCP hot path.
    if (cached && cached.configRef === params.cfg && now - cached.time < TOOL_CACHE_TTL_MS) {
      return cached;
    }

    const next = resolveMcpLoopbackScopedTools({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      messageProvider: params.messageProvider,
      currentChannelId: params.currentChannelId,
      currentThreadTs: params.currentThreadTs,
      currentMessageId: params.currentMessageId,
      accountId: params.accountId,
      inboundEventKind: params.inboundEventKind,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      senderIsOwner: params.senderIsOwner,
    });
    const nextEntry: CachedScopedTools = {
      agentId: next.agentId,
      tools: next.tools,
      toolSchema: buildMcpToolSchema(next.tools),
      configRef: params.cfg,
      time: now,
    };
    this.#entries.set(cacheKey, nextEntry);
    for (const [key, entry] of this.#entries) {
      if (now - entry.time >= TOOL_CACHE_TTL_MS) {
        this.#entries.delete(key);
      }
    }
    return nextEntry;
  }
}
