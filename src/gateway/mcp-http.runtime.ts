import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  registerMcpLoopbackScopeInvalidator,
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

function buildCacheKey(params: {
  sessionKey: string;
  messageProvider: string | undefined;
  accountId: string | undefined;
  senderIsOwner: boolean | undefined;
}): string {
  return [
    params.sessionKey,
    params.messageProvider ?? "",
    params.accountId ?? "",
    params.senderIsOwner === true ? "owner" : params.senderIsOwner === false ? "non-owner" : "",
  ].join("\u0000");
}

// The cache keys on the authoritative scope tuple carried by a registered
// loopback token (see registerMcpLoopbackToken). Scope is never read from
// attacker-controllable request headers, so two separately-registered
// tokens with different scopes get independent cache entries.
export class McpLoopbackToolCache {
  #entries = new Map<string, CachedScopedTools>();
  #unregisterInvalidator: (() => void) | undefined;

  constructor() {
    this.#unregisterInvalidator = registerMcpLoopbackScopeInvalidator((scope) => {
      this.invalidateForScope(scope);
    });
  }

  dispose(): void {
    this.#unregisterInvalidator?.();
    this.#unregisterInvalidator = undefined;
    this.#entries.clear();
  }

  resolve(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    messageProvider: string | undefined;
    accountId: string | undefined;
    senderIsOwner: boolean | undefined;
  }): CachedScopedTools {
    const cacheKey = buildCacheKey(params);
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
    return nextEntry;
  }

  invalidateForScope(scope: {
    sessionKey: string;
    messageProvider?: string | undefined;
    accountId?: string | undefined;
    senderIsOwner?: boolean | undefined;
  }): void {
    this.#entries.delete(
      buildCacheKey({
        sessionKey: scope.sessionKey,
        messageProvider: scope.messageProvider,
        accountId: scope.accountId,
        senderIsOwner: scope.senderIsOwner,
      }),
    );
  }
}

export {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
};
