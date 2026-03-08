import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemorySearchResult } from "../../memory/types.js";

export type MemoryPrefetchResult = {
  /** Formatted context block to inject, or null if skipped/unavailable. */
  context: string | null;
  /** Where to inject: into user message body or system prompt. */
  injection: "system" | "context";
};

/**
 * Auto-prefetch memory search results for an incoming user message.
 *
 * Returns a formatted "Memory context" block if autoPrefetch is enabled
 * and the message passes all skip checks. Returns null context otherwise.
 * Errors are swallowed to avoid breaking normal message flow.
 */
export async function runMemoryPrefetch(params: {
  message: string;
  sessionKey: string;
  cfg: OpenClawConfig;
}): Promise<MemoryPrefetchResult> {
  const { message, sessionKey, cfg } = params;
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const memCfg = resolveMemorySearchConfig(cfg, agentId);

  const noResult: MemoryPrefetchResult = { context: null, injection: "context" };

  if (!memCfg || !memCfg.autoPrefetch.enabled) {
    return noResult;
  }

  const ap = memCfg.autoPrefetch;

  // Skip short messages
  if (message.length < ap.minMessageLength) {
    return noResult;
  }

  // Skip messages matching any skip pattern
  for (const pattern of ap.skipPatterns) {
    try {
      if (new RegExp(pattern).test(message)) {
        return noResult;
      }
    } catch {
      // Invalid regex — ignore this pattern
    }
  }

  try {
    const { manager } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      return noResult;
    }

    const results = await manager.search(message, {
      maxResults: ap.maxResults,
      sessionKey,
    });

    if (!results.length) {
      return noResult;
    }

    const context = formatMemoryContext(results);
    return { context, injection: ap.injection };
  } catch {
    // Graceful degradation: prefetch failure must not break message dispatch
    return noResult;
  }
}

function formatMemoryContext(results: MemorySearchResult[]): string {
  const lines = ["## Memory context"];
  for (const r of results) {
    const lineRef = r.startLine === r.endLine ? `L${r.startLine}` : `L${r.startLine}-L${r.endLine}`;
    lines.push(`\n[${r.path}#${lineRef}]\n${r.snippet.trim()}`);
  }
  return lines.join("\n");
}
