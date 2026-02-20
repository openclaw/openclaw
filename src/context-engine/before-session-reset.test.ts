import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runBeforeSessionResetLifecycle } from "./before-session-reset.js";
import { registerContextEngine } from "./registry.js";
import type { AssembleResult, CompactResult, ContextEngine, IngestResult } from "./types.js";

class TestContextEngine implements ContextEngine {
  readonly info = { id: "test", name: "Test Engine" };
  private readonly onBeforeSessionReset?: (params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    reason: "new" | "reset";
  }) => Promise<void>;
  private readonly onDispose?: () => Promise<void>;

  constructor(params: {
    onBeforeSessionReset?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      reason: "new" | "reset";
    }) => Promise<void>;
    onDispose?: () => Promise<void>;
  }) {
    this.onBeforeSessionReset = params.onBeforeSessionReset;
    this.onDispose = params.onDispose;
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
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    return { messages: params.messages, estimatedTokens: 0 };
  }

  async compact(_params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
  }): Promise<CompactResult> {
    return { ok: true, compacted: false };
  }

  async beforeSessionReset(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    reason: "new" | "reset";
  }): Promise<void> {
    await this.onBeforeSessionReset?.(params);
  }

  async dispose(): Promise<void> {
    await this.onDispose?.();
  }
}

describe("runBeforeSessionResetLifecycle", () => {
  it("calls beforeSessionReset when the active engine implements it", async () => {
    const beforeSpy = vi.fn(async () => {});
    const disposeSpy = vi.fn(async () => {});
    const engineId = `before-reset-${Date.now()}-a`;
    registerContextEngine(
      engineId,
      () =>
        new TestContextEngine({
          onBeforeSessionReset: beforeSpy,
          onDispose: disposeSpy,
        }),
    );

    const cfg = {
      plugins: { slots: { contextEngine: engineId } },
    } as OpenClawConfig;
    await runBeforeSessionResetLifecycle({
      cfg,
      sessionId: "sess-before-reset",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/sess-before-reset.jsonl",
      reason: "new",
    });

    expect(beforeSpy).toHaveBeenCalledWith({
      sessionId: "sess-before-reset",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/sess-before-reset.jsonl",
      reason: "new",
    });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("returns early when sessionId is missing", async () => {
    const engineId = `before-reset-${Date.now()}-b`;
    const factorySpy = vi.fn(() => new TestContextEngine({}));
    registerContextEngine(engineId, factorySpy);

    const cfg = {
      plugins: { slots: { contextEngine: engineId } },
    } as OpenClawConfig;
    await runBeforeSessionResetLifecycle({
      cfg,
      sessionId: "",
      sessionFile: "/tmp/sess-before-reset.jsonl",
      reason: "reset",
    });

    expect(factorySpy).not.toHaveBeenCalled();
  });
});
