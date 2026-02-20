import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "./types.js";
import { registerContextEngine } from "./registry.js";

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

  async afterTurn(_params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void> {
    // No-op: legacy flow persists context directly in SessionManager.
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
  }): Promise<CompactResult> {
    // Import dynamically to avoid circular dependencies
    const { compactEmbeddedPiSessionDirect } =
      await import("../agents/pi-embedded-runner/compact.js");

    // legacyParams carries the full CompactEmbeddedPiSessionParams fields
    // set by the caller in run.ts. We spread them and override the fields
    // that come from the ContextEngine compact() signature directly.
    const lp = params.legacyParams ?? {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy bridge: legacyParams is an opaque bag matching CompactEmbeddedPiSessionParams
    const result = await compactEmbeddedPiSessionDirect({
      ...lp,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      tokenBudget: params.tokenBudget,
      force: params.force,
      customInstructions: params.customInstructions,
      workspaceDir: (lp.workspaceDir as string) ?? process.cwd(),
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
