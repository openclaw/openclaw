import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineSessionTarget,
  AssembleResult,
  CompactResult,
  IngestResult,
} from "./types.js";

/** A minimal mock engine that satisfies the ContextEngine interface. */
export class MockContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "mock",
    name: "Mock Engine",
    version: "0.0.1",
  };

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: MemoryCitationsMode;
  }): Promise<AssembleResult> {
    return {
      messages: params.messages,
      estimatedTokens: 42,
      systemPromptAddition: "mock system addition",
    };
  }

  async compact(_params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    sessionTarget?: ContextEngineSessionTarget;
    tokenBudget?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: true,
      reason: "mock compaction",
      result: {
        summary: "mock summary",
        tokensBefore: 100,
        tokensAfter: 50,
      },
    };
  }

  async dispose(): Promise<void> {
    // no-op
  }
}

export function createPassthroughEngineMethods(): Pick<
  ContextEngine,
  "ingest" | "assemble" | "compact"
> {
  return {
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
}
