import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runtimeErrorMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
    exit: vi.fn(),
  },
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

function makeFollowupRun(): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "telegram",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
}

function callRunReplyAgent() {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "telegram",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;

  return runReplyAgent({
    commandBody: "hello",
    followupRun: makeFollowupRun(),
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing,
    sessionCtx,
    defaultModel: "anthropic/claude-opus-4-5",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
}

describe("runReplyAgent API error retry", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runtimeErrorMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once after transient 521 HTML failure and then succeeds", async () => {
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(
        new Error(
          `521 <!DOCTYPE html><html lang="en-US"><head><title>Web server is down</title></head><body>Cloudflare</body></html>`,
        ),
      )
      .mockResolvedValueOnce({
        payloads: [{ text: "Recovered response" }],
        meta: {},
      });

    const runPromise = callRunReplyAgent();
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await runPromise;

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runtimeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Retryable API error before reply"),
    );

    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("Recovered response");
  });

  it("retries on Anthropic overloaded_error and recovers", async () => {
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(
        new Error('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      )
      .mockResolvedValueOnce({
        payloads: [{ text: "Recovered after overload" }],
        meta: {},
      });

    const runPromise = callRunReplyAgent();
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await runPromise;

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runtimeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Retryable API error before reply (attempt 1/3)"),
    );
    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("Recovered after overload");
  });

  it("retries up to 3 times with increasing backoff then fails", async () => {
    const overloadedError = new Error("overloaded_error: Overloaded");

    // 1 initial attempt + 3 retries = 4 total attempts, all failing
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(overloadedError)
      .mockRejectedValueOnce(overloadedError)
      .mockRejectedValueOnce(overloadedError)
      .mockRejectedValueOnce(overloadedError);

    const runPromise = callRunReplyAgent();
    // Advance through all 3 retry delays: 2500 + 5000 + 10000
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await runPromise;

    // 1 initial + 3 retries = 4 total calls
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(4);
    // After exhausting retries, the 4th failure falls through to the error response
    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("Agent failed before reply");
  });

  it("retries on rate_limit error", async () => {
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(new Error("rate_limit: too many requests"))
      .mockResolvedValueOnce({
        payloads: [{ text: "Recovered after rate limit" }],
        meta: {},
      });

    const runPromise = callRunReplyAgent();
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await runPromise;

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("Recovered after rate limit");
  });

  it("does NOT retry on auth errors (401)", async () => {
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("401 Unauthorized: Invalid API key"));

    const runPromise = callRunReplyAgent();
    const result = await runPromise;

    // Auth errors are not retryable — should fail immediately
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("Agent failed before reply");
  });
});
