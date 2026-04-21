import type { OpenClawConfig } from "../config/types.openclaw.js";
import { syncMcpAppResources } from "./mcp-app-resources.js";
import {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";
import {
  buildMcpToolSchema,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const TOOL_CACHE_TTL_MS = 30_000;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

type CachedScopedTools = {
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  configRef: OpenClawConfig;
  time: number;
};

export class McpLoopbackToolCache {
  #entries = new Map<string, CachedScopedTools>();
  #owner: string;

  constructor(owner = "default") {
    this.#owner = owner;
  }

  resolve(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    messageProvider: string | undefined;
    accountId: string | undefined;
    senderIsOwner: boolean | undefined;
  }): CachedScopedTools {
    const cacheKey = [
      params.sessionKey,
      params.messageProvider ?? "",
      params.accountId ?? "",
      params.senderIsOwner === true ? "owner" : params.senderIsOwner === false ? "non-owner" : "",
    ].join("\u0000");
    const now = Date.now();
    const cached = this.#entries.get(cacheKey);
    if (cached && cached.configRef === params.cfg && now - cached.time < TOOL_CACHE_TTL_MS) {
      return cached;
    }

    const next = resolveGatewayScopedTools({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      messageProvider: params.messageProvider,
      accountId: params.accountId,
      senderIsOwner: params.senderIsOwner,
      surface: "loopback",
      excludeToolNames: NATIVE_TOOL_EXCLUDE,
    });
    const nextEntry: CachedScopedTools = {
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
    // Sync resources with the union of ALL active cache entries' tools so that
    // one session's cache refresh does not evict resources owned by another session.
    // The owner key ensures cross-surface caches (HTTP vs WS) don't evict each other.
    const allActiveTools = [...this.#entries.values()].flatMap((e) => e.tools);
    syncMcpAppResources(allActiveTools, this.#owner);
    return nextEntry;
  }
}

export {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
};
