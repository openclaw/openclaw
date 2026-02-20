import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { AgentRunLoopResult } from "./agent-runner-execution.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  runAgentTurnWithFallbackMock: vi.fn(),
  verifyAgentResponseMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
}));

vi.mock("./agent-runner-execution.js", () => ({
  runAgentTurnWithFallback: (...args: unknown[]) => state.runAgentTurnWithFallbackMock(...args),
}));

vi.mock("./agent-verifier.js", () => ({
  verifyAgentResponse: (...args: unknown[]) => state.verifyAgentResponseMock(...args),
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: (...args: unknown[]) => state.emitAgentEventMock(...args),
  registerAgentRunContext: vi.fn(),
  onAgentEvent: vi.fn(() => () => {}),
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

let runReplyAgentPromise:
  | Promise<(typeof import("./agent-runner.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("./agent-runner.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

function makeSuccessOutcome(
  payloads: ReplyPayload[],
  overrides?: Partial<Extract<AgentRunLoopResult, { kind: "success" }>>,
): AgentRunLoopResult {
  return {
    kind: "success",
    runId: "test-run-id",
    runResult: { payloads, meta: { durationMs: 100 } },
    fallbackAttempts: [],
    didLogHeartbeatStrip: false,
    autoCompactionCompleted: false,
    ...overrides,
  };
}

function createVerifierRun(params?: {
  config?: Record<string, unknown>;
  opts?: GetReplyOptions;
  commandBody?: string;
  blockStreamingEnabled?: boolean;
  provider?: string;
}) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const followupRun = {
    prompt: params?.commandBody ?? "Build me a REST API",
    summaryLine: "Build me a REST API",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: params?.config ?? {},
      skillsSnapshot: {},
      provider: params?.provider ?? "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 5_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return {
    typing,
    run: async () => {
      const runReplyAgent = await getRunReplyAgent();
      return runReplyAgent({
        commandBody: params?.commandBody ?? "Build me a REST API",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        opts: params?.opts,
        typing,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-5",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
      });
    },
  };
}

function verifierEnabledConfig(overrides?: Record<string, unknown>) {
  return {
    agents: {
      defaults: {
        verifier: {
          enabled: true,
          model: "anthropic/claude-sonnet-4-5",
          maxAttempts: 3,
          ...overrides,
        },
      },
    },
  };
}

function getEmittedPhases(): string[] {
  return state.emitAgentEventMock.mock.calls
    .map((c: unknown[]) => {
      const arg = c[0] as { data?: { phase?: string } } | undefined;
      return arg?.data?.phase;
    })
    .filter(Boolean) as string[];
}

beforeEach(() => {
  state.runAgentTurnWithFallbackMock.mockReset();
  state.verifyAgentResponseMock.mockReset();
  state.emitAgentEventMock.mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

describe("agent verifier integration", () => {
  it("does not call verifyAgentResponse when verifier is disabled", async () => {
    state.runAgentTurnWithFallbackMock.mockResolvedValueOnce(
      makeSuccessOutcome([{ text: "I'm done with the task." }]),
    );

    const { run } = createVerifierRun({
      config: { agents: { defaults: { verifier: { enabled: false } } } },
    });
    const result = await run();

    expect(state.verifyAgentResponseMock).not.toHaveBeenCalled();
    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("done"))).toBe(true);
  });

  it("verifies on first attempt and passes — single run, no retry", async () => {
    state.runAgentTurnWithFallbackMock.mockResolvedValueOnce(
      makeSuccessOutcome([{ text: "I'm done building the API." }]),
    );
    state.verifyAgentResponseMock.mockResolvedValueOnce({ passed: true });

    const { run } = createVerifierRun({ config: verifierEnabledConfig() });
    const result = await run();

    expect(state.runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(state.verifyAgentResponseMock).toHaveBeenCalledTimes(1);

    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("done"))).toBe(true);

    expect(state.emitAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "verification_pass", attempt: 1 }),
      }),
    );
  });

  it("retries when first verification fails, then passes on second attempt", async () => {
    state.runAgentTurnWithFallbackMock
      .mockResolvedValueOnce(makeSuccessOutcome([{ text: "I'm done with the REST API." }]))
      .mockResolvedValueOnce(
        makeSuccessOutcome([{ text: "Done! Added error handling with try/catch blocks." }]),
      );

    state.verifyAgentResponseMock
      .mockResolvedValueOnce({ passed: false, feedback: "Missing error handling" })
      .mockResolvedValueOnce({ passed: true });

    const { run } = createVerifierRun({ config: verifierEnabledConfig() });
    const result = await run();

    expect(state.runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(state.verifyAgentResponseMock).toHaveBeenCalledTimes(2);

    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("error handling"))).toBe(true);

    const phases = getEmittedPhases();
    expect(phases).toContain("verification_fail");
    expect(phases).toContain("verification_retry");
    expect(phases).toContain("verification_pass");
  });

  it("delivers latest response when max attempts exhausted (best-effort)", async () => {
    state.runAgentTurnWithFallbackMock
      .mockResolvedValueOnce(makeSuccessOutcome([{ text: "Done with the first attempt." }]))
      .mockResolvedValueOnce(makeSuccessOutcome([{ text: "Done with the second attempt." }]))
      .mockResolvedValueOnce(makeSuccessOutcome([{ text: "Done with the third attempt." }]));

    state.verifyAgentResponseMock
      .mockResolvedValueOnce({ passed: false, feedback: "Incomplete" })
      .mockResolvedValueOnce({ passed: false, feedback: "Still incomplete" })
      .mockResolvedValueOnce({ passed: false, feedback: "Not good enough" });

    const { run } = createVerifierRun({ config: verifierEnabledConfig() });
    const result = await run();

    expect(state.runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(3);
    expect(state.verifyAgentResponseMock).toHaveBeenCalledTimes(3);

    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("third attempt"))).toBe(true);

    expect(getEmittedPhases()).toContain("verification_exhausted");
  });

  it("skips verification for heartbeat runs", async () => {
    state.runAgentTurnWithFallbackMock.mockResolvedValueOnce(
      makeSuccessOutcome([{ text: "I'm done with the heartbeat check." }]),
    );

    const { run } = createVerifierRun({
      config: verifierEnabledConfig(),
      opts: { isHeartbeat: true },
    });
    await run();

    expect(state.verifyAgentResponseMock).not.toHaveBeenCalled();
  });

  it("skips verification when block streaming already delivered content", async () => {
    state.runAgentTurnWithFallbackMock.mockResolvedValueOnce(
      makeSuccessOutcome([{ text: "I'm done with the streamed response." }], {
        directlySentBlockKeys: new Set(["block-0"]),
      }),
    );

    const { run } = createVerifierRun({ config: verifierEnabledConfig() });
    await run();

    expect(state.verifyAgentResponseMock).not.toHaveBeenCalled();
  });

  it("skips verification when payloadArray is empty", async () => {
    state.runAgentTurnWithFallbackMock.mockResolvedValueOnce(makeSuccessOutcome([]));

    const { run } = createVerifierRun({ config: verifierEnabledConfig() });
    await run();

    expect(state.verifyAgentResponseMock).not.toHaveBeenCalled();
  });

  // The real verifyAgentResponse catches LLM errors internally and returns
  // { passed: true } (fail-open). This test verifies the system-level behavior:
  // verification is attempted, the verifier fails open, and the response is delivered.
  it("delivers original response when verifier encounters LLM error (fail-open)", async () => {
    state.runAgentTurnWithFallbackMock.mockResolvedValueOnce(
      makeSuccessOutcome([{ text: "I'm done with the API implementation." }]),
    );

    state.verifyAgentResponseMock.mockResolvedValueOnce({ passed: true });

    const { run } = createVerifierRun({ config: verifierEnabledConfig() });
    const result = await run();

    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("API implementation"))).toBe(true);

    expect(state.verifyAgentResponseMock).toHaveBeenCalledTimes(1);
    expect(state.runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(1);
  });

  it("skips verification when response has no trigger keywords", async () => {
    state.runAgentTurnWithFallbackMock.mockResolvedValueOnce(
      makeSuccessOutcome([{ text: "Here is some intermediate analysis of the problem." }]),
    );

    const { run } = createVerifierRun({
      config: verifierEnabledConfig({ triggerKeywords: ["done", "completed", "finished"] }),
    });
    const result = await run();

    expect(state.verifyAgentResponseMock).not.toHaveBeenCalled();
    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("intermediate analysis"))).toBe(true);
  });

  it("verifyAll: true verifies even when no trigger keywords match", async () => {
    state.runAgentTurnWithFallbackMock.mockResolvedValueOnce(
      makeSuccessOutcome([{ text: "Here is some intermediate analysis of the problem." }]),
    );
    state.verifyAgentResponseMock.mockResolvedValueOnce({ passed: true });

    const { run } = createVerifierRun({
      config: verifierEnabledConfig({ verifyAll: true }),
    });
    const result = await run();

    expect(state.verifyAgentResponseMock).toHaveBeenCalledTimes(1);
    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("intermediate analysis"))).toBe(true);
    expect(getEmittedPhases()).toContain("verification_pass");
  });

  it("verifyAll: true retries on failure even without trigger keywords", async () => {
    state.runAgentTurnWithFallbackMock
      .mockResolvedValueOnce(makeSuccessOutcome([{ text: "Here is my analysis of the codebase." }]))
      .mockResolvedValueOnce(
        makeSuccessOutcome([{ text: "Updated analysis with deeper coverage." }]),
      );

    state.verifyAgentResponseMock
      .mockResolvedValueOnce({ passed: false, feedback: "Too shallow" })
      .mockResolvedValueOnce({ passed: true });

    const { run } = createVerifierRun({
      config: verifierEnabledConfig({ verifyAll: true }),
    });
    const result = await run();

    expect(state.runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(state.verifyAgentResponseMock).toHaveBeenCalledTimes(2);

    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("deeper coverage"))).toBe(true);

    const phases = getEmittedPhases();
    expect(phases).toContain("verification_fail");
    expect(phases).toContain("verification_retry");
    expect(phases).toContain("verification_pass");
  });

  // Abort fires during verify. The current iteration completes (including one retry),
  // then the abort check at the top of the next iteration breaks the loop.
  it("delivers current response when abort signal fires during verification", async () => {
    const abortController = new AbortController();

    state.runAgentTurnWithFallbackMock
      .mockResolvedValueOnce(makeSuccessOutcome([{ text: "I'm done with the initial response." }]))
      .mockResolvedValueOnce(makeSuccessOutcome([{ text: "Done — improved after feedback." }]));

    state.verifyAgentResponseMock.mockImplementationOnce(async () => {
      abortController.abort();
      return { passed: false, feedback: "Needs improvement" };
    });

    const { run } = createVerifierRun({
      config: verifierEnabledConfig(),
      opts: { abortSignal: abortController.signal },
    });
    const result = await run();

    // 2 calls: initial + 1 retry before abort detected at next iteration
    expect(state.runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(state.verifyAgentResponseMock).toHaveBeenCalledTimes(1);

    const payloads = Array.isArray(result) ? result : [result];
    expect(payloads.some((p) => p?.text?.includes("improved"))).toBe(true);
  });
});
