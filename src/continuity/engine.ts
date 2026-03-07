import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { LegacyContextEngine } from "../context-engine/legacy.js";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "../context-engine/types.js";
import type { ContinuityService } from "./service.js";

export class ContinuityContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "continuity",
    name: "Continuity Context Engine",
    version: "0.1.0",
  };

  private readonly legacy = new LegacyContextEngine();

  constructor(
    private readonly service: ContinuityService,
    private readonly agentId?: string,
  ) {}

  async bootstrap(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<{ bootstrapped: boolean; reason?: string }> {
    return { bootstrapped: false, reason: "continuity bootstraps lazily" };
  }

  async ingest(_params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const addition = await this.service.buildSystemPromptAddition({
      agentId: this.agentId,
      sessionKey: params.sessionKey,
      messages: params.messages,
    });
    return {
      messages: params.messages,
      estimatedTokens: 0,
      systemPromptAddition: addition,
    };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void> {
    if (params.isHeartbeat) {
      return;
    }
    if (!params.sessionKey) {
      return;
    }
    const newMessages = params.messages.slice(params.prePromptMessageCount);
    if (newMessages.length === 0) {
      return;
    }
    await this.service.captureTurn({
      agentId: this.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messages: newMessages,
    });
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
    legacyParams?: Record<string, unknown>;
  }): Promise<CompactResult> {
    return this.legacy.compact(params);
  }

  async dispose(): Promise<void> {
    await this.legacy.dispose?.();
  }
}
