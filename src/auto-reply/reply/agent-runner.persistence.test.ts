
import { describe, expect, it, vi } from "vitest";
import { runReplyAgent } from "./agent-runner.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import * as attemptExecutionRuntime from "../../agents/command/attempt-execution.runtime.js";

vi.mock("./agent-runner-execution.js", async () => {
  const actual = await vi.importActual<any>("./agent-runner-execution.js");
  return {
    ...actual,
    runAgentTurnWithFallback: vi.fn(),
  };
});

vi.mock("../../agents/command/attempt-execution.runtime.js", () => ({
  persistCliTurnTranscript: vi.fn(async (params: any) => params.sessionEntry),
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

vi.mock("../../infra/diagnostic-events.js", () => ({
  emitTrustedDiagnosticEvent: vi.fn(),
  isDiagnosticsEnabled: vi.fn(() => false),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  hasSessionAutoModelFallbackProvenance: vi.fn(() => false),
  hasConfiguredModelFallbacks: vi.fn(() => false),
  resolveAgentConfig: vi.fn(() => ({})),
  resolveSessionAgentId: vi.fn(() => "test-agent"),
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: vi.fn(() => ({ enabled: false })),
}));

vi.mock("../../agents/identity.js", () => ({
  resolveAgentIdentity: vi.fn(() => ({})),
}));

vi.mock("../../utils/usage-format.js", () => ({
  estimateUsageCost: vi.fn(() => 0),
  formatTokenCount: vi.fn((n) => String(n)),
  resolveModelCostConfig: vi.fn(() => ({})),
}));

vi.mock("../fallback-state.js", () => ({
  resolveFallbackTransition: vi.fn(() => ({ stateChanged: false })),
}));

vi.mock("./agent-runner-helpers.js", () => ({
  createShouldEmitToolOutput: vi.fn(() => () => false),
  createShouldEmitToolResult: vi.fn(() => () => false),
  isAudioPayload: vi.fn(() => false),
  signalTypingIfNeeded: vi.fn(),
}));

vi.mock("./agent-runner-payloads.js", () => ({
  buildReplyPayloads: vi.fn(() => []),
}));

vi.mock("./agent-runner-usage-line.js", () => ({
  appendUsageLine: vi.fn(),
  formatResponseUsageLine: vi.fn(() => undefined),
}));

vi.mock("../../config/sessions.js", () => ({
  applySessionStoreEntryPatch: vi.fn(),
  updateSessionStoreEntry: vi.fn(),
}));

describe("runReplyAgent persistence", () => {
  it("persists CLI responses to the transcript", async () => {
    vi.mocked(runAgentTurnWithFallback).mockResolvedValue({
      kind: "success",
      runId: "test-run",
      runResult: {
        meta: {
          executionTrace: { runner: "cli" },
        },
        payloads: [],
      } as any,
      fallbackProvider: "test-provider",
      fallbackModel: "test-model",
      fallbackAttempts: [],
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
      directlySentBlockPayloads: [],
    });

    const followupRun: any = {
      run: {
        provider: "test-provider",
        model: "test-model",
        agentId: "test-agent",
        cwd: "/test",
        sessionId: "test-session-id",
      },
    };

    const params: any = {
      commandBody: "test command",
      followupRun,
      queueKey: "test-queue",
      resolvedQueue: { mode: "parallel" },
      shouldSteer: false,
      shouldFollowup: false,
      isActive: true,
      isStreaming: false,
      typing: {
          setPhase: vi.fn(),
          addInteraction: vi.fn(),
      },
      sessionKey: "test-session-key",
      defaultModel: "test-model",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "text_end",
      sessionCtx: {
          ReplyThreading: "all",
      },
      shouldInjectGroupIntro: false,
      typingMode: "off",
      replyOperation: {
          setPhase: vi.fn(),
          fail: vi.fn(),
      }
    };

    await runReplyAgent(params);

    expect(attemptExecutionRuntime.persistCliTurnTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-session-id",
        sessionKey: "test-session-key",
      }),
    );
  });

  it("persists embedded gap-fill responses to the transcript", async () => {
    vi.mocked(runAgentTurnWithFallback).mockResolvedValue({
      kind: "success",
      runId: "test-run",
      runResult: {
        meta: {
          finalAssistantVisibleText: "some gap fill text",
        },
        payloads: [],
      } as any,
      fallbackProvider: "test-provider",
      fallbackModel: "test-model",
      fallbackAttempts: [],
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
      directlySentBlockPayloads: [],
    });

    const followupRun: any = {
      run: {
        provider: "test-provider",
        model: "test-model",
        agentId: "test-agent",
        cwd: "/test",
        sessionId: "test-session-id",
      },
    };

    const params: any = {
      commandBody: "test command",
      followupRun,
      queueKey: "test-queue",
      resolvedQueue: { mode: "parallel" },
      shouldSteer: false,
      shouldFollowup: false,
      isActive: true,
      isStreaming: false,
      typing: {
          setPhase: vi.fn(),
          addInteraction: vi.fn(),
      },
      sessionKey: "test-session-key",
      defaultModel: "test-model",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "text_end",
      sessionCtx: {
          ReplyThreading: "all",
      },
      shouldInjectGroupIntro: false,
      typingMode: "off",
      replyOperation: {
          setPhase: vi.fn(),
          fail: vi.fn(),
      }
    };

    await runReplyAgent(params);

    expect(attemptExecutionRuntime.persistCliTurnTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-session-id",
        sessionKey: "test-session-key",
        embeddedAssistantGapFill: true,
      }),
    );
  });
});
