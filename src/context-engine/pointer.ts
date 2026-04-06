import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens, SessionManager } from "@mariozechner/pi-coding-agent";
import { registerContextEngineForOwner } from "./registry.js";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

const HOT_TAIL_DEFAULT = 10;

// Compact when usage reaches 85% of budget (unless forced)
const COMPACT_THRESHOLD_RATIO = 0.85;

type RuntimeCtxWithConfig = ContextEngineRuntimeContext & {
  config?: {
    agents?: {
      defaults?: {
        compaction?: {
          hotTailTurns?: number;
        };
      };
    };
  };
};

/**
 * Safely extract the content array or string from an AgentMessage.
 * Returns undefined for message types that don't have content.
 */
function getMessageContent(msg: AgentMessage): string | readonly unknown[] | undefined {
  if ("content" in msg) {
    return msg.content as string | readonly unknown[];
  }
  return undefined;
}

/**
 * Extract topic hints from a set of messages.
 *
 * Pulls tool names from tool_use blocks and the first meaningful text snippet
 * from user messages, deduplicates, and caps the list for readability.
 */
function extractTopicHints(messages: AgentMessage[]): string[] {
  const hints = new Set<string>();

  for (const msg of messages) {
    const content = getMessageContent(msg);
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "tool_use" &&
          "name" in block &&
          typeof (block as Record<string, unknown>).name === "string"
        ) {
          hints.add((block as Record<string, string>).name);
        }
      }
    }
    // First short text snippet from user messages as a topic hint
    if (msg.role === "user" && hints.size < 8) {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter(
                  (b): b is { type: "text"; text: string } =>
                    b !== null &&
                    typeof b === "object" &&
                    "type" in b &&
                    (b as Record<string, unknown>).type === "text" &&
                    "text" in b &&
                    typeof (b as Record<string, unknown>).text === "string",
                )
                .map((b) => b.text)
                .join(" ")
            : "";
      const snippet = text.trim().slice(0, 40).replace(/\s+/g, " ");
      if (snippet.length > 10) {
        hints.add(snippet + (text.trim().length > 40 ? "…" : ""));
      }
    }
  }

  // Cap hints to avoid overly long markers
  return [...hints].slice(0, 6);
}

/**
 * Count discrete tool/event interactions in a message set.
 */
function countEvents(messages: AgentMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    const content = getMessageContent(msg);
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block !== null && typeof block === "object" && "type" in block) {
          const type = (block as Record<string, unknown>).type;
          if (type === "tool_use" || type === "tool_result") {
            count++;
          }
        }
      }
    }
  }
  return count;
}

/**
 * Format the structured pointer compaction marker inserted in place of
 * compacted turns. This is a plain-text string stored in the compaction
 * entry's `summary` field and shown to the model as a compactionSummary
 * message, so it must be provider-agnostic.
 */
function formatPointerMarker(params: {
  firstTurn: number;
  lastTurn: number;
  tokensFreed: number;
  topicHints: string[];
  eventCount: number;
}): string {
  const { firstTurn, lastTurn, tokensFreed, topicHints, eventCount } = params;
  const range = firstTurn === lastTurn ? `Turn ${firstTurn}` : `Turns ${firstTurn}–${lastTurn}`;
  const topicsText = topicHints.length > 0 ? topicHints.join(", ") : "general conversation";
  const eventsText = eventCount > 0 ? ` ${eventCount} events.` : "";
  return (
    `[📌 ${range} compacted (~${tokensFreed} tokens). Topics: ${topicsText}.${eventsText}` +
    ` Use memory/recall to retrieve full context.]`
  );
}

type SessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  message?: AgentMessage;
};

/**
 * PointerContextEngine implements lossless compaction by replacing old turns
 * with a structured marker message instead of an LLM-generated narrative.
 *
 * Old turns remain in the session JSONL (accessible via recall) but are
 * excluded from the active context window. No LLM call is required.
 *
 * Configured via compaction.mode: "pointer" and compaction.hotTailTurns.
 */
export class PointerContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "pointer",
    name: "Pointer Context Engine",
    version: "1.0.0",
    // This engine owns its compaction algorithm — no LLM summary needed.
    ownsCompaction: true,
  };

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // No-op: SessionManager handles message persistence in the pointer flow
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
  }): Promise<AssembleResult> {
    // Pass-through: the compacted session file already has the pointer marker
    // in place of old turns, so the standard Pi session context assembly works
    // without any additional processing here.
    return {
      messages: params.messages,
      estimatedTokens: 0,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    const { sessionFile, tokenBudget, force } = params;

    // Resolve hotTailTurns from runtimeContext.config (set by the caller)
    const rtCtx = params.runtimeContext as RuntimeCtxWithConfig | undefined;
    const hotTailTurns =
      rtCtx?.config?.agents?.defaults?.compaction?.hotTailTurns ?? HOT_TAIL_DEFAULT;

    let sm: SessionManager;
    try {
      sm = SessionManager.open(sessionFile);
    } catch (err) {
      return {
        ok: false,
        compacted: false,
        reason: `Failed to open session file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // getBranch() returns entries from root to current leaf in linear order
    const branch = sm.getBranch() as SessionEntry[];

    // Work only with message-type entries
    const messageEntries = branch.filter((e) => e.type === "message" && e.message !== undefined);

    if (messageEntries.length === 0) {
      return { ok: true, compacted: false, reason: "empty session" };
    }

    const messages = messageEntries.map((e) => e.message as AgentMessage);

    // Use caller-supplied token count when available; fall back to estimation
    const estimatedTotal = messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
    const currentTokens = params.currentTokenCount ?? estimatedTotal;

    // Skip compaction when under budget (unless forced)
    if (
      !force &&
      tokenBudget &&
      tokenBudget > 0 &&
      currentTokens < tokenBudget * COMPACT_THRESHOLD_RATIO
    ) {
      return {
        ok: true,
        compacted: false,
        reason: `within budget (${currentTokens}/${tokenBudget} tokens)`,
      };
    }

    // Identify consecutive user→assistant turn pairs
    const turnPairStartIndices: number[] = [];
    for (let i = 0; i < messageEntries.length - 1; i++) {
      const cur = messages[i];
      const next = messages[i + 1];
      if (cur.role === "user" && next.role === "assistant") {
        turnPairStartIndices.push(i);
        i++; // advance past the assistant message
      }
    }

    // Hot tail: the last N complete turn pairs (user+assistant)
    const hotTailPairStart = Math.max(0, turnPairStartIndices.length - hotTailTurns);
    // Index into messageEntries of the first hot-tail user message
    const hotTailFirstMsgIdx =
      hotTailPairStart < turnPairStartIndices.length
        ? turnPairStartIndices[hotTailPairStart]
        : messageEntries.length;

    // Find the compactable range: skip protected messages at the head
    // (system messages and existing compactionSummary markers)
    let compactFrom = 0;
    while (compactFrom < hotTailFirstMsgIdx) {
      const role = messages[compactFrom].role;
      if (role === "compactionSummary" || role === "branchSummary") {
        compactFrom++;
      } else {
        break;
      }
    }

    if (compactFrom >= hotTailFirstMsgIdx) {
      return {
        ok: true,
        compacted: false,
        reason: "no compactable messages outside hot tail",
      };
    }

    // Estimate tokens freed by compacting this range
    const messagesToCompact = messages.slice(compactFrom, hotTailFirstMsgIdx);
    const tokensFreed = messagesToCompact.reduce((sum, msg) => sum + estimateTokens(msg), 0);

    if (tokensFreed === 0) {
      return { ok: true, compacted: false, reason: "zero tokens to free" };
    }

    // Build the marker
    const topicHints = extractTopicHints(messagesToCompact);
    const eventCount = countEvents(messagesToCompact);
    const firstTurn = compactFrom + 1;
    const lastTurn = hotTailFirstMsgIdx;

    const marker = formatPointerMarker({
      firstTurn,
      lastTurn,
      tokensFreed,
      topicHints,
      eventCount,
    });

    // firstKeptEntryId: first message the model should still see verbatim
    const firstKeptEntry = messageEntries[hotTailFirstMsgIdx];
    const firstKeptEntryId = firstKeptEntry?.id ?? "";

    // Append the compaction entry to the session file.
    // appendCompaction() persists synchronously via appendFileSync.
    sm.appendCompaction(marker, firstKeptEntryId, estimatedTotal);

    return {
      ok: true,
      compacted: true,
      result: {
        summary: marker,
        firstKeptEntryId: firstKeptEntryId ?? undefined,
        tokensBefore: estimatedTotal,
        tokensAfter: estimatedTotal - tokensFreed,
      },
    };
  }

  async dispose(): Promise<void> {
    // Nothing to clean up
  }
}

export function registerPointerContextEngine(): void {
  registerContextEngineForOwner("pointer", () => new PointerContextEngine(), "core", {
    allowSameOwnerRefresh: true,
  });
}
