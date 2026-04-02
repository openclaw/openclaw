/**
 * Tests for responsePrefix application in cron delivery dispatch.
 *
 * Regression: messages.responsePrefix was applied to normal user→agent→reply
 * messages but NOT to cron-delivered messages. This file verifies that
 * deliverViaDirect() applies the configured prefix to outbound payloads
 * with the same idempotency guard used by the heartbeat runner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks (must be hoisted before imports) ---

vi.mock("../../agents/identity.js", () => ({
  resolveEffectiveMessagesConfig: vi.fn().mockReturnValue({ responsePrefix: "🔥" }),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn(({ agentId }: { agentId: string }) => `agent:${agentId}:main`),
  resolveMainSessionKey: vi.fn(() => "global"),
}));

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
  logError: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./subagent-followup.js", () => ({
  expectsSubagentFollowup: vi.fn().mockReturnValue(false),
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
  readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import { resolveEffectiveMessagesConfig } from "../../agents/identity.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  dispatchCronDelivery,
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
    channel: "whatsapp",
    to: "123456@s.whatsapp.net",
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

function makeBaseParams(overrides: {
  synthesizedText?: string;
  deliveryPayloads?: { text?: string; mediaUrl?: string }[];
  deliveryPayloadHasStructuredContent?: boolean;
}) {
  const resolvedDelivery = makeResolvedDelivery();
  const text = overrides.synthesizedText ?? "Hello world";
  return {
    cfg: {} as never,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      sessionTarget: "isolated",
      deleteAfterRun: false,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main",
    runSessionId: `run-${Date.now()}`,
    runStartedAt: Date.now(),
    runEndedAt: Date.now(),
    timeoutMs: 30_000,
    resolvedDelivery,
    deliveryRequested: true,
    skipHeartbeatDelivery: false,
    deliveryBestEffort: false,
    deliveryPayloadHasStructuredContent: overrides.deliveryPayloadHasStructuredContent ?? false,
    deliveryPayloads: overrides.deliveryPayloads ?? [{ text }],
    synthesizedText: text,
    summary: text,
    outputText: text,
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: makeWithRunSession(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchCronDelivery — responsePrefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCompletedDirectCronDeliveriesForTests();
    vi.mocked(resolveEffectiveMessagesConfig).mockReturnValue({
      messagePrefix: "",
      responsePrefix: "🔥",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies responsePrefix to text payloads", async () => {
    const params = makeBaseParams({ synthesizedText: "Good morning!" });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "🔥 Good morning!" }],
      }),
    );
  });

  it("does not double-prefix when text already starts with prefix", async () => {
    const params = makeBaseParams({ synthesizedText: "🔥 Already prefixed" });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "🔥 Already prefixed" }],
      }),
    );
  });

  it("leaves payloads unchanged when responsePrefix is undefined", async () => {
    vi.mocked(resolveEffectiveMessagesConfig).mockReturnValue({
      messagePrefix: "",
      responsePrefix: undefined,
    });

    const params = makeBaseParams({ synthesizedText: "No prefix configured" });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "No prefix configured" }],
      }),
    );
  });

  it("does not modify media-only payloads without text", async () => {
    const mediaPayload = { mediaUrl: "https://example.com/image.png" };
    const params = makeBaseParams({
      deliveryPayloads: [mediaPayload],
      deliveryPayloadHasStructuredContent: true,
    });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [mediaPayload],
      }),
    );
  });

  it("applies prefix to synthesizedText fallback when deliveryPayloads is empty", async () => {
    const params = makeBaseParams({
      deliveryPayloads: [],
      synthesizedText: "Fallback text",
    });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "🔥 Fallback text" }],
      }),
    );
  });

  it("applies prefix when text starts with prefix chars but no boundary follows", async () => {
    vi.mocked(resolveEffectiveMessagesConfig).mockReturnValue({
      messagePrefix: "",
      responsePrefix: "Hi",
    });

    const params = makeBaseParams({ synthesizedText: "History report" });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "Hi History report" }],
      }),
    );
  });

  it("recognizes already-prefixed text when prefix ends with whitespace", async () => {
    vi.mocked(resolveEffectiveMessagesConfig).mockReturnValue({
      messagePrefix: "",
      responsePrefix: "[bot] ",
    });

    const params = makeBaseParams({ synthesizedText: "[bot] hello" });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "[bot] hello" }],
      }),
    );
  });

  it("does not double-space when prefix already ends with whitespace", async () => {
    vi.mocked(resolveEffectiveMessagesConfig).mockReturnValue({
      messagePrefix: "",
      responsePrefix: "[bot] ",
    });

    const params = makeBaseParams({ synthesizedText: "new message" });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "[bot] new message" }],
      }),
    );
  });

  it("does not prepend a stray space when responsePrefix is empty string", async () => {
    vi.mocked(resolveEffectiveMessagesConfig).mockReturnValue({
      messagePrefix: "",
      responsePrefix: "",
    });

    const params = makeBaseParams({ synthesizedText: "No stray space" });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "No stray space" }],
      }),
    );
  });
});
