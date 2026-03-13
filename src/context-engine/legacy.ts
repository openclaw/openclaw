import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { registerContextEngine } from "./registry.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

const log = createSubsystemLogger("legacy-context-engine");

/** Default proactive auto-compaction threshold (fraction of context window). */
export const DEFAULT_AUTO_COMPACTION_THRESHOLD = 0.75;

/**
 * Estimate total token count for a message array using the same heuristic
 * as the compaction subsystem (chars/4). Returns 0 on estimation failure.
 */
export function estimateMessageTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    try {
      total += estimateTokens(msg);
    } catch {
      // Estimation failure on a single message — skip, don't abort.
    }
  }
  return total;
}

/**
 * Resolve the effective auto-compaction threshold from config.
 * Returns `null` when auto-compaction is explicitly disabled (set to 0 or falsy mode).
 */
export function resolveAutoCompactionThreshold(config?: OpenClawConfig): number | null {
  const value = config?.agents?.defaults?.compaction?.autoThreshold;
  if (value === undefined || value === null) {
    return DEFAULT_AUTO_COMPACTION_THRESHOLD;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AUTO_COMPACTION_THRESHOLD;
  }
  // Clamp to valid range
  if (value < 0.5) {
    return 0.5;
  }
  if (value > 0.95) {
    return 0.95;
  }
  return value;
}

/**
 * LegacyContextEngine wraps the existing compaction behavior behind the
 * ContextEngine interface, preserving 100% backward compatibility.
 *
 * - ingest: no-op (SessionManager handles message persistence)
 * - assemble: pass-through (existing sanitize/validate/limit pipeline in attempt.ts handles this)
 * - compact: delegates to compactEmbeddedPiSessionDirect
 */
export class LegacyContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "legacy",
    name: "Legacy Context Engine",
    version: "1.0.0",
  };

  async ingest(_params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // No-op: SessionManager handles message persistence in the legacy flow
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    // Pass-through: the existing sanitize -> validate -> limit -> repair pipeline
    // in attempt.ts handles context assembly for the legacy engine.
    // We just return the messages as-is with a rough token estimate.
    return {
      messages: params.messages,
      estimatedTokens: 0, // Caller handles estimation
    };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
    skipAutoCompaction?: boolean;
  }): Promise<void> {
    // Guard: skip auto-compaction when the runner already timed out during a
    // compaction attempt this turn.  Re-triggering compact() here would create
    // a stall loop in the exact recovery path meant to avoid them.
    if (params.skipAutoCompaction) {
      return;
    }

    // Proactive auto-compaction: estimate current token usage and compact
    // before the next turn hits a provider overflow error.
    const { messages, tokenBudget, runtimeContext } = params;
    if (!tokenBudget || tokenBudget <= 0 || messages.length === 0) {
      return;
    }

    const config = runtimeContext?.config as OpenClawConfig | undefined;
    const threshold = resolveAutoCompactionThreshold(config);
    if (threshold === null) {
      return;
    }

    const currentTokens = estimateMessageTokens(messages);
    const triggerAt = Math.floor(tokenBudget * threshold);

    if (currentTokens < triggerAt) {
      return;
    }

    const ratio = currentTokens / tokenBudget;
    log.info(
      `[auto-compaction] triggered: sessionId=${params.sessionId} ` +
        `tokens=${currentTokens} budget=${tokenBudget} ratio=${ratio.toFixed(3)} ` +
        `threshold=${threshold} triggerAt=${triggerAt}`,
    );

    try {
      const result = await this.compact({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        tokenBudget,
        force: true,
        currentTokenCount: currentTokens,
        compactionTarget: "budget",
        runtimeContext,
      });

      if (result.compacted) {
        log.info(
          `[auto-compaction] completed: sessionId=${params.sessionId} ` +
            `tokensBefore=${result.result?.tokensBefore ?? "?"} ` +
            `tokensAfter=${result.result?.tokensAfter ?? "?"}`,
        );
      } else {
        log.info(
          `[auto-compaction] skipped by compactor: sessionId=${params.sessionId} ` +
            `reason=${result.reason ?? "unknown"}`,
        );
      }
    } catch (err) {
      // Auto-compaction is best-effort — don't crash the session.
      log.warn(
        `[auto-compaction] failed: sessionId=${params.sessionId} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    // Import through a dedicated runtime boundary so the lazy edge remains effective.
    const { compactEmbeddedPiSessionDirect } =
      await import("../agents/pi-embedded-runner/compact.runtime.js");

    // runtimeContext carries the full CompactEmbeddedPiSessionParams fields
    // set by the caller in run.ts. We spread them and override the fields
    // that come from the ContextEngine compact() signature directly.
    const runtimeContext = params.runtimeContext ?? {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridge runtimeContext matches CompactEmbeddedPiSessionParams
    const result = await compactEmbeddedPiSessionDirect({
      ...runtimeContext,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      tokenBudget: params.tokenBudget,
      force: params.force,
      customInstructions: params.customInstructions,
      workspaceDir: (runtimeContext.workspaceDir as string) ?? process.cwd(),
    } as Parameters<typeof compactEmbeddedPiSessionDirect>[0]);

    return {
      ok: result.ok,
      compacted: result.compacted,
      reason: result.reason,
      result: result.result
        ? {
            summary: result.result.summary,
            firstKeptEntryId: result.result.firstKeptEntryId,
            tokensBefore: result.result.tokensBefore,
            tokensAfter: result.result.tokensAfter,
            details: result.result.details,
          }
        : undefined,
    };
  }

  async dispose(): Promise<void> {
    // Nothing to clean up for legacy engine
  }
}

export function registerLegacyContextEngine(): void {
  registerContextEngine("legacy", () => new LegacyContextEngine());
}
