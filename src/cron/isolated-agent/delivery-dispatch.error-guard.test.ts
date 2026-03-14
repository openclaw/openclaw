/**
 * Tests for the error-output delivery guard in cron delivery dispatch.
 *
 * Bug (#42243): When a cron job's model provider returns an error (e.g.
 * HTTP 500), the raw error JSON becomes the agent's synthesized text.
 * With `delivery.mode: "announce"`, this error dump was delivered to
 * user-facing channels (Discord, Telegram, etc.) as normal content.
 *
 * Fix: `isLikelyRawErrorOutput()` detects common error patterns in the
 * synthesized text and `dispatchCronDelivery` skips delivery when matched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks (must be hoisted before imports) ---

vi.mock("../../agents/subagent-registry.js", () => ({
  countActiveDescendantRuns: vi.fn().mockReturnValue(0),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([{ ok: true }]),
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("./subagent-followup.js", () => ({
  expectsSubagentFollowup: vi.fn().mockReturnValue(false),
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
  readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { logWarn } from "../../logger.js";
import {
  dispatchCronDelivery,
  isLikelyRawErrorOutput,
  resetCompletedDirectCronDeliveriesForTests,
} from "./delivery-dispatch.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolvedDelivery(): Extract<DeliveryTargetResolution, { ok: true }> {
  return {
    ok: true,
    channel: "discord",
    to: "channel-42",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
  };
}

function makeWithRunSession() {
  return (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: "test-session-id",
    sessionKey: "test-session-key",
  });
}

function makeBaseParams(overrides: { synthesizedText?: string; deliveryRequested?: boolean }) {
  const resolvedDelivery = makeResolvedDelivery();
  return {
    cfg: {} as never,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      deleteAfterRun: false,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main",
    runSessionId: "run-err-guard-123",
    runStartedAt: Date.now(),
    runEndedAt: Date.now(),
    timeoutMs: 30_000,
    resolvedDelivery,
    deliveryRequested: overrides.deliveryRequested ?? true,
    skipHeartbeatDelivery: false,
    deliveryBestEffort: false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : [],
    synthesizedText: overrides.synthesizedText,
    summary: overrides.synthesizedText,
    outputText: overrides.synthesizedText,
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: makeWithRunSession(),
  };
}

// ---------------------------------------------------------------------------
// Unit tests for isLikelyRawErrorOutput
// ---------------------------------------------------------------------------

describe("isLikelyRawErrorOutput", () => {
  it("detects JSON error objects from providers", () => {
    const openaiError = `{"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."}}`;
    expect(isLikelyRawErrorOutput(openaiError)).toBe(true);
  });

  it("detects provider error wrapper format", () => {
    const codexError = `Codex error: {"type":"error","error":{"type":"server_error","message":"Internal error"}}`;
    expect(isLikelyRawErrorOutput(codexError)).toBe(true);
  });

  it("detects JS runtime exceptions", () => {
    expect(isLikelyRawErrorOutput("TypeError: Cannot read properties of undefined")).toBe(true);
    expect(isLikelyRawErrorOutput("RangeError: Maximum call stack size exceeded")).toBe(true);
    expect(isLikelyRawErrorOutput("Error: ECONNREFUSED")).toBe(true);
    expect(isLikelyRawErrorOutput("SyntaxError: Unexpected token")).toBe(true);
    expect(isLikelyRawErrorOutput("ReferenceError: x is not defined")).toBe(true);
  });

  it("detects common provider error messages in JSON", () => {
    const error = `{"message":"An error occurred while processing your request. You can retry your request."}`;
    expect(isLikelyRawErrorOutput(error)).toBe(true);
  });

  it("detects JSON error objects with code:invalid_request", () => {
    const text = '{"code": "invalid_request", "detail": "bad param"}';
    expect(isLikelyRawErrorOutput(text)).toBe(true);
  });

  it("detects HTTP status code error patterns", () => {
    expect(isLikelyRawErrorOutput("error: status code 500 from upstream")).toBe(true);
    expect(isLikelyRawErrorOutput("Error response with code 429 - rate limited")).toBe(true);
  });

  it("does not flag normal agent output", () => {
    expect(isLikelyRawErrorOutput("Here is your sales report for today.")).toBe(false);
    expect(isLikelyRawErrorOutput("No new emails found.")).toBe(false);
    expect(isLikelyRawErrorOutput("Task completed successfully.")).toBe(false);
  });

  it("does not flag output containing the word error in normal context", () => {
    expect(
      isLikelyRawErrorOutput("I found 3 error reports in the email inbox that need attention."),
    ).toBe(false);
    expect(
      isLikelyRawErrorOutput(
        "I checked the error logs and everything looks fine. No issues found today.",
      ),
    ).toBe(false);
  });

  it("does not flag empty or very large text", () => {
    expect(isLikelyRawErrorOutput("")).toBe(false);
    expect(isLikelyRawErrorOutput("   \n  ")).toBe(false);
    expect(isLikelyRawErrorOutput("x".repeat(6000))).toBe(false);
  });

  it("does not flag long text even if it starts with an error pattern", () => {
    const longText = "Error: something went wrong\n" + "x".repeat(5100);
    expect(isLikelyRawErrorOutput(longText)).toBe(false);
  });

  it("handles whitespace-padded error output", () => {
    const padded = `  \n  {"type":"error","error":{"code":"invalid_request","message":"bad"}}  \n`;
    expect(isLikelyRawErrorOutput(padded)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests through dispatchCronDelivery
// ---------------------------------------------------------------------------

describe("dispatchCronDelivery — error output guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCompletedDirectCronDeliveriesForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips delivery when synthesized text is a raw JSON error", async () => {
    const errorJson = JSON.stringify({
      type: "error",
      error: { type: "server_error", message: "Internal server error" },
    });
    const params = makeBaseParams({ synthesizedText: errorJson });
    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(false);
    expect(state.result).toBeUndefined();
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("suppressed announce delivery of raw error output"),
    );
  });

  it("skips delivery when synthesized text is a JS exception", async () => {
    const params = makeBaseParams({
      synthesizedText: "TypeError: Cannot read properties of undefined (reading 'map')",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(false);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("allows delivery for normal agent output", async () => {
    const params = makeBaseParams({
      synthesizedText: "Your daily sales report is ready. 3 new leads today.",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.deliveryAttempted).toBe(true);
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("allows delivery when synthesized text is undefined", async () => {
    const params = makeBaseParams({ synthesizedText: undefined });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toBeUndefined();
  });

  it("skips delivery for HTTP 500 error pattern in text", async () => {
    const params = makeBaseParams({
      synthesizedText: "error: status code 500 from model provider",
    });
    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(false);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("preserves summary and outputText in the returned state even when skipping", async () => {
    const errorText = "Error: ECONNREFUSED 127.0.0.1:18789";
    const params = makeBaseParams({ synthesizedText: errorText });
    const state = await dispatchCronDelivery(params);

    expect(state.synthesizedText).toBe(errorText);
    expect(state.outputText).toBe(errorText);
    expect(state.summary).toBe(errorText);
    expect(state.delivered).toBe(false);
  });

  it("guard fires even when delivery is not explicitly requested", async () => {
    const errorJson = JSON.stringify({
      type: "error",
      error: { type: "server_error", message: "fail" },
    });
    const params = makeBaseParams({
      synthesizedText: errorJson,
      deliveryRequested: false,
    });
    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(false);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
