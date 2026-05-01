/**
 * Tests for BlueBubbles cron transcript mirror.
 *
 * Context: cron deliveries historically did not write anything to the target
 * channel's session transcript, so when a BlueBubbles recipient replied in
 * plain text (no iMessage reply-quote, which is how most people use BB
 * groups), the agent saw an orphan user message and could not reconstruct
 * what cron had pushed earlier.
 *
 * Fix: when cron delivers to channel=bluebubbles, set `mirror` on the
 * outbound delivery so deliver.ts appends the payload text to the target
 * session transcript. Scope limited to bluebubbles — other channels keep
 * the previous no-mirror behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOutboundBaseSessionKey } from "../../infra/outbound/base-session-key.js";
import type { ResolveOutboundSessionRouteParams } from "../../infra/outbound/outbound-session.js";

const sessionMetaMocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveStorePath: vi.fn(
    (_store: unknown, params?: { agentId?: string }) => `/stores/${params?.agentId ?? "main"}.json`,
  ),
}));

// --- Module mocks (must be hoisted before imports) ---

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn(({ agentId }: { agentId: string }) => `agent:${agentId}:main`),
  resolveMainSessionKey: vi.fn(() => "global"),
}));

vi.mock("../../config/sessions/inbound.runtime.js", () => ({
  recordSessionMetaFromInbound: sessionMetaMocks.recordSessionMetaFromInbound,
  resolveStorePath: sessionMetaMocks.resolveStorePath,
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
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

vi.mock("../../gateway/call.runtime.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./subagent-followup-hints.js", () => ({
  expectsSubagentFollowup: vi.fn().mockReturnValue(false),
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
}));

vi.mock("./subagent-followup.runtime.js", () => ({
  readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  dispatchCronDelivery,
  resetCompletedDirectCronDeliveriesForTests,
} from "./delivery-dispatch.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBluebubblesDelivery(): Extract<DeliveryTargetResolution, { ok: true }> {
  return {
    ok: true,
    channel: "bluebubbles",
    to: "chat_guid:iMessage;+;test-group-guid",
    accountId: "default",
    threadId: undefined,
    mode: "explicit",
  };
}

function makeBluebubblesDirectDelivery(): Extract<DeliveryTargetResolution, { ok: true }> {
  return {
    ok: true,
    channel: "bluebubbles",
    to: "chat_guid:iMessage;-;+15551234567",
    accountId: "default",
    threadId: undefined,
    mode: "explicit",
  };
}

function makeTelegramDelivery(): Extract<DeliveryTargetResolution, { ok: true }> {
  return {
    ok: true,
    channel: "telegram",
    to: "-100123456",
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
  resolvedDelivery: Extract<DeliveryTargetResolution, { ok: true }>;
  synthesizedText?: string;
}) {
  return {
    cfg: { session: { dmScope: "per-channel-peer" } } as never,
    cfgWithAgentDefaults: { session: { dmScope: "per-channel-peer" } } as never,
    deps: {} as never,
    job: {
      id: "oura-daily",
      name: "Oura Daily",
      sessionTarget: "isolated",
      deleteAfterRun: false,
      payload: { kind: "agentTurn", message: "summarize" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main",
    runSessionKey: "test-run-session-key",
    sessionId: "test-session-id",
    runStartedAt: Date.now(),
    runEndedAt: Date.now(),
    timeoutMs: 30_000,
    resolvedDelivery: overrides.resolvedDelivery,
    deliveryRequested: true,
    skipHeartbeatDelivery: false,
    deliveryBestEffort: false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : [],
    synthesizedText: overrides.synthesizedText ?? "Oura morning briefing...",
    summary: overrides.synthesizedText ?? "Oura morning briefing...",
    outputText: overrides.synthesizedText ?? "Oura morning briefing...",
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: makeWithRunSession(),
  };
}

function resolveBlueBubblesOutboundSessionRouteForTest(params: ResolveOutboundSessionRouteParams) {
  const stripped = params.target.replace(/^bluebubbles:/i, "").trim();
  const chatGuid = stripped.replace(/^chat_guid:/i, "");
  const parts = chatGuid.split(";");
  const isDirectChatGuid = /^chat_guid:/i.test(stripped) && parts.length === 3 && parts[1] === "-";
  const isGroupChatGuid = /^chat_guid:/i.test(stripped) && parts.length === 3 && parts[1] === "+";
  const peer = isDirectChatGuid
    ? { kind: "direct" as const, id: parts[2].trim() }
    : {
        kind: "group" as const,
        id: isGroupChatGuid ? chatGuid : stripped,
      };
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "bluebubbles",
    accountId: params.accountId,
    peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer,
    chatType: peer.kind,
    from: peer.kind === "direct" ? `bluebubbles:${peer.id}` : `group:${peer.id}`,
    to: `bluebubbles:${stripped}`,
  };
}

function installBlueBubblesRoutePlugin(
  resolveOutboundSessionRoute = resolveBlueBubblesOutboundSessionRouteForTest,
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "bluebubbles",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "bluebubbles",
            label: "BlueBubbles",
            capabilities: { chatTypes: ["direct", "group"] },
          }),
          messaging: {
            resolveOutboundSessionRoute,
          },
        },
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchCronDelivery — BlueBubbles transcript mirror", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installBlueBubblesRoutePlugin();
    resetCompletedDirectCronDeliveriesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("BlueBubbles cron delivery includes a mirror with the group target session key", async () => {
    const params = makeBaseParams({
      resolvedDelivery: makeBluebubblesDelivery(),
      synthesizedText: "Oura morning briefing: sleep 7h23m, readiness 88, HRV 45",
    });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(deliverOutboundPayloads).mock.calls[0]?.[0];
    expect(callArg?.mirror).toBeDefined();
    expect(callArg?.mirror).toMatchObject({
      sessionKey: "agent:main:bluebubbles:group:imessage;+;test-group-guid",
      agentId: "main",
      text: "Oura morning briefing: sleep 7h23m, readiness 88, HRV 45",
      isGroup: true,
      groupId: "iMessage;+;test-group-guid",
    });
    expect(callArg?.mirror?.idempotencyKey).toBeDefined();
    // Reuses the delivery idempotency key (`cron-direct-delivery:v1:<execId>:<channel>:...`)
    // so retries dedup via appendMessage. Pin both the cron job id and the
    // channel to avoid asserting on the run-start timestamp embedded in the
    // execution id, which would couple the test to wall-clock state.
    expect(callArg?.mirror?.idempotencyKey).toContain("oura-daily");
    expect(callArg?.mirror?.idempotencyKey).toContain("bluebubbles");

    // The mirror path creates the outbound session entry before append.
    expect(sessionMetaMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    expect(sessionMetaMocks.recordSessionMetaFromInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/stores/main.json",
        sessionKey: "agent:main:bluebubbles:group:imessage;+;test-group-guid",
        ctx: expect.objectContaining({
          ChatType: "group",
          From: "group:iMessage;+;test-group-guid",
          To: "bluebubbles:chat_guid:iMessage;+;test-group-guid",
        }),
      }),
    );
  });

  it("non-BlueBubbles cron delivery does not set mirror (unchanged behavior)", async () => {
    const params = makeBaseParams({
      resolvedDelivery: makeTelegramDelivery(),
      synthesizedText: "Telegram topic push",
    });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(deliverOutboundPayloads).mock.calls[0]?.[0];
    expect(callArg?.mirror).toBeUndefined();
    // The outbound-session route seam is only used for BlueBubbles mirrors.
    expect(sessionMetaMocks.recordSessionMetaFromInbound).not.toHaveBeenCalled();
  });

  it("BlueBubbles cron delivery routes a `;-;` DM target to a direct peer (no group session)", async () => {
    // Regression for codex review P2: use the real BlueBubbles outbound route
    // seam, so `chat_guid:iMessage;-;...` normalizes to the same DM peer as a
    // handle target instead of a fabricated group session.
    const params = makeBaseParams({
      resolvedDelivery: makeBluebubblesDirectDelivery(),
      synthesizedText: "Direct reminder for one recipient",
    });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(deliverOutboundPayloads).mock.calls[0]?.[0];
    expect(callArg?.mirror).toMatchObject({
      sessionKey: "agent:main:bluebubbles:direct:+15551234567",
      isGroup: false,
      text: "Direct reminder for one recipient",
    });
    // groupId is omitted on DM mirrors.
    expect(callArg?.mirror).not.toHaveProperty("groupId");

    expect(sessionMetaMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    expect(sessionMetaMocks.recordSessionMetaFromInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:bluebubbles:direct:+15551234567",
        ctx: expect.objectContaining({
          ChatType: "direct",
          From: "bluebubbles:+15551234567",
          To: "bluebubbles:chat_guid:iMessage;-;+15551234567",
        }),
      }),
    );
  });

  it("BlueBubbles mirror falls back gracefully when outbound route resolution throws", async () => {
    installBlueBubblesRoutePlugin(() => {
      throw new Error("route resolution failed");
    });
    const params = makeBaseParams({
      resolvedDelivery: makeBluebubblesDelivery(),
      synthesizedText: "Fallback text",
    });
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(deliverOutboundPayloads).mock.calls[0]?.[0];
    // Mirror is omitted but delivery still proceeds.
    expect(callArg?.mirror).toBeUndefined();
    expect(callArg?.channel).toBe("bluebubbles");
  });

  it("multiple payloads are concatenated into the mirror text", async () => {
    const params = {
      ...makeBaseParams({
        resolvedDelivery: makeBluebubblesDelivery(),
      }),
      deliveryPayloads: [{ text: "Briefing part 1" }, { text: "Briefing part 2" }],
      synthesizedText: "fallback",
    };
    await dispatchCronDelivery(params);

    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(deliverOutboundPayloads).mock.calls[0]?.[0];
    expect(callArg?.mirror?.text).toBe("Briefing part 1\n\nBriefing part 2");
  });
});
