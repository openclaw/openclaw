import { describe, expect, it, vi, beforeEach } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import {
  formatAuthErrorMessage,
  formatBillingErrorMessage,
} from "../../agents/pi-embedded-helpers/errors.js";

// Mock heavy dependencies that runAgentTurnWithFallback imports.
// runWithModelFallback is the core dependency we control to simulate errors.
vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
  registerAgentRunContext: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentModelFallbacksOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn() },
}));

import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";

function createStubParams(overrides: Record<string, unknown> = {}) {
  return {
    commandBody: "test message",
    followupRun: {
      run: {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        config: {},
        agentDir: "/tmp/test",
        sessionId: "test-session",
        sessionKey: undefined,
        agentId: "main",
        sessionFile: "/tmp/session.json",
        workspaceDir: "/tmp",
        extraSystemPrompt: undefined,
        ownerNumbers: [],
        thinkLevel: undefined,
        verboseLevel: "off",
        reasoningLevel: undefined,
        execOverrides: undefined,
        skillsSnapshot: undefined,
        bashElevated: false,
        timeoutMs: 30000,
        authProfileId: undefined,
        authProfileIdSource: undefined,
      },
    },
    sessionCtx: {},
    opts: undefined,
    typingSignals: {
      signalTextDelta: vi.fn().mockResolvedValue(undefined),
      signalMessageStart: vi.fn().mockResolvedValue(undefined),
      signalReasoningDelta: vi.fn().mockResolvedValue(undefined),
      signalToolStart: vi.fn().mockResolvedValue(undefined),
      shouldStartOnReasoning: false,
    },
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "text_end" as const,
    applyReplyToMode: (p: unknown) => p,
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),
    resetSessionAfterCompactionFailure: vi.fn().mockResolvedValue(false),
    resetSessionAfterRoleOrderingConflict: vi.fn().mockResolvedValue(false),
    isHeartbeat: false,
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off" as const,
    ...overrides,
  } as Parameters<typeof runAgentTurnWithFallback>[0];
}

describe("runAgentTurnWithFallback - FailoverError handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns user-friendly billing error when FailoverError has billing reason", async () => {
    const billingError = new FailoverError(
      "All models failed: your API key has run out of credits",
      { reason: "billing", provider: "anthropic" },
    );
    vi.mocked(runWithModelFallback).mockRejectedValue(billingError);

    const result = await runAgentTurnWithFallback(createStubParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(formatBillingErrorMessage("anthropic"));
      expect(result.payload.text).toContain("billing error");
      expect(result.payload.text).not.toContain("Agent failed before reply");
    }
  });

  it("returns user-friendly auth error when FailoverError has auth reason", async () => {
    const authError = new FailoverError("All models failed: invalid API key", {
      reason: "auth",
      provider: "openai",
    });
    vi.mocked(runWithModelFallback).mockRejectedValue(authError);

    const result = await runAgentTurnWithFallback(createStubParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(formatAuthErrorMessage("openai"));
      expect(result.payload.text).toContain("openai");
      expect(result.payload.text).not.toContain("Agent failed before reply");
    }
  });

  it("includes provider name in billing error when available", async () => {
    const billingError = new FailoverError("billing error", {
      reason: "billing",
      provider: "google-ai-studio",
    });
    vi.mocked(runWithModelFallback).mockRejectedValue(billingError);

    const result = await runAgentTurnWithFallback(createStubParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(formatBillingErrorMessage("google-ai-studio"));
      expect(result.payload.text).toContain("google-ai-studio");
    }
  });

  it("uses generic auth message when provider is not specified", async () => {
    const authError = new FailoverError("auth error", {
      reason: "auth",
    });
    vi.mocked(runWithModelFallback).mockRejectedValue(authError);

    const result = await runAgentTurnWithFallback(createStubParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(formatAuthErrorMessage());
      expect(result.payload.text).not.toContain("Agent failed before reply");
    }
  });

  it("uses generic billing message when provider is not specified", async () => {
    const billingError = new FailoverError("billing error", {
      reason: "billing",
    });
    vi.mocked(runWithModelFallback).mockRejectedValue(billingError);

    const result = await runAgentTurnWithFallback(createStubParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(formatBillingErrorMessage());
      expect(result.payload.text).toContain("provider's billing dashboard");
    }
  });
});
