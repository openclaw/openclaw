import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";
import type { TemplateContext } from "../templating.js";
import type { TypingSignaler } from "./typing-mode.js";

// Mock dependencies
vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: vi.fn(),
  emitAgentEvent: vi.fn(),
}));

vi.mock("../../utils/message-channel.js", () => ({
  resolveMessageChannel: vi.fn().mockReturnValue("web"),
  isMarkdownCapableMessageChannel: vi.fn().mockReturnValue(true),
}));

describe("runAgentTurnWithFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should use fallback model when primary model fails with 429", async () => {
    // Setup config with fallbacks
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-2.5-flash",
            fallbacks: ["openrouter/moonshotai/kimi-k2.5"],
          },
        },
      },
    } as OpenClawConfig;

    // Mock runEmbeddedPiAgent behavior
    vi.mocked(runEmbeddedPiAgent)
      .mockRejectedValueOnce(Object.assign(new Error("HTTP 429: Rate limit exceeded"), { status: 429 }))
      .mockResolvedValueOnce({
        meta: {
          agentMeta: {
            provider: "openrouter",
            model: "moonshotai/kimi-k2.5",
          }
        },
        payloads: [{ text: "Fallback response" }],
      } as Awaited<ReturnType<typeof runEmbeddedPiAgent>>);

    // Setup params
    const followupRun = {
      run: {
        config: cfg,
        provider: "google",
        model: "gemini-2.5-flash",
        sessionKey: "test-session",
        sessionId: "test-run",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
      },
    } as unknown as FollowupRun;

    // Updated to match TemplateContext keys (PascalCase)
    const sessionCtx = {
        Provider: "web",
        AccountId: "user",
    } as unknown as TemplateContext;

    const typingSignals = {
        signalTextDelta: vi.fn(),
        signalMessageStart: vi.fn(),
        signalRunStart: vi.fn(),
        signalReasoningDelta: vi.fn(),
        signalToolStart: vi.fn(),
    } as unknown as TypingSignaler;

    // Run
    const result = await runAgentTurnWithFallback({
      commandBody: "Hello",
      followupRun,
      sessionCtx,
      typingSignals,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "text_end",
      applyReplyToMode: (p) => p,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: vi.fn().mockResolvedValue(false),
      resetSessionAfterRoleOrderingConflict: vi.fn().mockResolvedValue(false),
      isHeartbeat: false,
      sessionKey: "test-session",
      getActiveSessionEntry: () => ({} as SessionEntry),
      activeSessionStore: {},
      storePath: "/tmp/store",
      resolvedVerboseLevel: "off",
    });

    // Verify result
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
        expect(result.fallbackProvider).toBe("openrouter");
        expect(result.fallbackModel).toBe("moonshotai/kimi-k2.5");
    }

    // Verify calls
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(2);
    // First call with primary
    expect(runEmbeddedPiAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({
        provider: "google",
        model: "gemini-2.5-flash",
    }));
    // Second call with fallback
    expect(runEmbeddedPiAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
        provider: "openrouter",
        model: "moonshotai/kimi-k2.5",
    }));
  });
});
