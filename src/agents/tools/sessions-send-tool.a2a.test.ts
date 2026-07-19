// sessions_send A2A tests cover announce delivery, same-session replies, delayed
// reply baselines, and channel target/account routing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { readLatestAssistantReplySnapshot, waitForAgentRun } from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import type { GatewaySessionListRow } from "./sessions-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import { testing } from "./sessions-send-tool.a2a.test-support.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const runtimeIdentityMocks = vi.hoisted(() => ({
  mintRuntimeIdentity: vi.fn(async (_params: unknown) => "signed-announce-runtime"),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../gateway/agent-runtime-identity-token.js", () => ({
  mintAgentRuntimeIdentityToken: (params: unknown) =>
    runtimeIdentityMocks.mintRuntimeIdentity(params),
}));

vi.mock("../run-wait.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-wait.js")>();
  return {
    ...actual,
    waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
    readLatestAssistantReplySnapshot: vi.fn().mockResolvedValue({
      text: "Test announce reply",
      fingerprint: "test-announce-reply",
    }),
  };
});

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
}));

function firstMockArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call[0] as Record<string, unknown>;
}

function createTestTurnAuthority(params?: {
  agentId?: string;
  sessionKey?: string;
}): TurnAuthoritySnapshot {
  return createTurnAuthoritySnapshot({
    principal: {
      kind: "sender",
      provider: "discord",
      accountId: "molty",
      senderId: "restricted-maintainer",
      senderIsOwner: false,
      isAuthorizedSender: true,
      roleIds: ["maintainers"],
    },
    agentId: params?.agentId ?? "main",
    sessionKey: params?.sessionKey ?? "agent:main:discord:channel:maintenance",
    sessionId: "source-session",
    runId: "source-run",
    conversationId: "channel:maintenance",
    parentConversationId: "channel:maintenance",
    threadId: "source-thread",
    trigger: "message",
    controllerKey: "sender:discord:molty:restricted-maintainer",
  });
}

describe("runSessionsSendA2AFlow announce delivery", () => {
  const sameSessionSourceRoute = {
    channel: "discord",
    to: "channel:target-room",
  } as const;
  let gatewayCalls: CallGatewayOptions[];
  let sessionListRows: GatewaySessionListRow[];
  let turnAuthority: TurnAuthoritySnapshot;

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    sessionListRows = [];
    turnAuthority = createTestTurnAuthority();
    callGatewayMock.mockReset();
    const callGateway = async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
      gatewayCalls.push(opts);
      if (opts.method === "sessions.list") {
        return { sessions: sessionListRows } as T;
      }
      return {} as T;
    };
    callGatewayMock.mockImplementation(callGateway);
    vi.clearAllMocks();
    vi.mocked(runAgentStep).mockReset().mockResolvedValue("Test announce reply");
    vi.mocked(waitForAgentRun).mockReset().mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReplySnapshot).mockReset().mockResolvedValue({
      text: "Test announce reply",
      fingerprint: "test-announce-reply",
    });
    testing.setDepsForTest({
      callGateway,
    });
  });

  function requireGatewayCall(method: string): CallGatewayOptions {
    const call = gatewayCalls.find((entry) => entry.method === method);
    if (!call) {
      throw new Error(`expected gateway call ${method}`);
    }
    return call;
  }

  afterEach(() => {
    testing.setDepsForTest();
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
      turnAuthority,
    });

    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
    expect(sendParams.agentId).toBe("main");
    expect(sendParams.sessionKey).toBe("agent:main:telegram:group:-100123:topic:554");
    expect(sendCall).toMatchObject({
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "agent",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.write"],
      requireLocalBackendSharedAuth: true,
      agentRuntimeIdentityToken: "signed-announce-runtime",
    });
    expect(runtimeIdentityMocks.mintRuntimeIdentity).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:group:-100123:topic:554",
      gatewayMethods: ["send"],
      messageActionContext: {
        expiresAtMs: expect.any(Number),
        turnAuthority: expect.objectContaining({
          authorization: expect.objectContaining({
            principal: expect.objectContaining({
              kind: "sender",
              senderId: "restricted-maintainer",
              senderIsOwner: false,
            }),
            agentId: "main",
            sessionKey: "agent:main:telegram:group:-100123:topic:554",
            conversationId: "channel:maintenance",
            threadId: "source-thread",
            trigger: "sessions_send",
          }),
          controllerKey: "sender:discord:molty:restricted-maintainer",
        }),
      },
    });
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
      turnAuthority,
    });

    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });

  it("bypasses the announce decider for same-session channel replies", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterSourceRoute: sameSessionSourceRoute,
      roundOneReply: "Substantive channel reply",
      turnAuthority,
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.message).toBe("Substantive channel reply");
  });

  it("bypasses the announce decider for delayed same-session channel replies", async () => {
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "Delayed channel reply",
      fingerprint: "delayed-channel-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterSourceRoute: sameSessionSourceRoute,
      baseline: {
        text: "Previous channel reply",
        fingerprint: "previous-channel-reply",
      },
      waitRunId: "run-delayed-channel",
      turnAuthority,
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe(
      "run-delayed-channel",
    );
    expect(
      firstMockArg(vi.mocked(readLatestAssistantReplySnapshot), "assistant reply snapshot")
        .sessionKey,
    ).toBe("agent:main:discord:channel:target-room");
    expect(
      firstMockArg(vi.mocked(readLatestAssistantReplySnapshot), "assistant reply snapshot")
        .attributableToRunId,
    ).toBe("run-delayed-channel");
    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.message).toBe("Delayed channel reply");
  });

  it("does not direct-deliver a delayed same-session reply that matches the baseline", async () => {
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "Previous channel reply",
      fingerprint: "previous-channel-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterAgentId: "main",
      requesterChannel: "discord",
      baseline: {
        text: "Previous channel reply",
        fingerprint: "previous-channel-reply",
      },
      waitRunId: "run-delayed-channel",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe(
      "run-delayed-channel",
    );
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("suppresses delayed cross-session replies when baseline history was unavailable", async () => {
    // Without a baseline fingerprint, a delayed assistant reply may be stale;
    // avoid direct delivery unless freshness is provable.
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      waitRunId: "run-delayed-channel",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe(
      "run-delayed-channel",
    );
    expect(readLatestAssistantReplySnapshot).not.toHaveBeenCalled();
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("delivers a delayed first reply after a known-empty baseline", async () => {
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "First channel reply",
      fingerprint: "first-channel-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterSourceRoute: sameSessionSourceRoute,
      baseline: {},
      waitRunId: "run-first-channel-reply",
      turnAuthority,
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    expect(sendCall.params).toMatchObject({
      channel: "discord",
      to: "channel:target-room",
      message: "First channel reply",
    });
  });

  it("delivers a legitimate reply that quotes incomplete-turn text", async () => {
    const reply = 'The log says "Agent couldn\'t generate a response", but the retry succeeded.';

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Diagnose the failed turn",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterSourceRoute: sameSessionSourceRoute,
      roundOneReply: reply,
      turnAuthority,
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = requireGatewayCall("send");
    expect((sendCall.params as Record<string, unknown>).message).toBe(reply);
  });

  it("does not use mutable delivery metadata when the immutable source route is unavailable", async () => {
    vi.mocked(runAgentStep).mockResolvedValueOnce("ANNOUNCE_SKIP");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterAgentId: "main",
      requesterChannel: "webchat",
      roundOneReply: "Substantive channel reply",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("delivers same-session replies only to the immutable source route", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:stale-room",
      targetAgentId: "main",
      displayKey: "agent:main:discord:channel:stale-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:stale-room",
      requesterAgentId: "main",
      requesterChannel: "discord",
      requesterSourceRoute: {
        channel: "discord",
        to: "channel:trusted-current-room",
        accountId: "work",
        threadId: "42",
      },
      roundOneReply: "Substantive channel reply",
      turnAuthority: createTestTurnAuthority({
        agentId: "main",
        sessionKey: "agent:main:discord:channel:stale-room",
      }),
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(requireGatewayCall("send").params).toMatchObject({
      channel: "discord",
      to: "channel:trusted-current-room",
      accountId: "work",
      threadId: "42",
    });
  });

  it("treats scoped and custom unscoped keys as the same immutable source endpoint", async () => {
    const customSessionKey = "custom-ops-session";
    sessionListRows = [
      {
        key: customSessionKey,
        agentId: "ops",
        kind: "other",
        channel: "discord",
        deliveryContext: { channel: "discord", to: "channel:stale-room" },
      },
    ];

    await runSessionsSendA2AFlow({
      targetSessionKey: customSessionKey,
      targetAgentId: "ops",
      displayKey: customSessionKey,
      message: "Test custom-session alias",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: `agent:ops:${customSessionKey}`,
      requesterAgentId: "ops",
      requesterChannel: "discord",
      requesterSourceRoute: {
        channel: "discord",
        to: "channel:trusted-current-room",
        accountId: "work",
        threadId: "42",
      },
      roundOneReply: "Substantive custom-session reply",
      turnAuthority: createTestTurnAuthority({
        agentId: "ops",
        sessionKey: `agent:ops:${customSessionKey}`,
      }),
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "sessions.list")).toBeUndefined();
    expect(requireGatewayCall("send").params).toMatchObject({
      channel: "discord",
      to: "channel:trusted-current-room",
      accountId: "work",
      threadId: "42",
      agentId: "ops",
      sessionKey: customSessionKey,
    });
  });

  it("keeps cross-agent global endpoints distinct through ping-pong and announce", async () => {
    sessionListRows = [
      {
        key: "global",
        agentId: "target",
        kind: "main",
        channel: "discord",
        deliveryContext: { channel: "discord", to: "channel:target-global" },
      },
    ];
    const globalAuthority = createTestTurnAuthority({
      agentId: "source",
      sessionKey: "global",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "global",
      targetAgentId: "target",
      displayKey: "global",
      message: "Test global message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "global",
      requesterAgentId: "source",
      requesterChannel: "discord",
      roundOneReply: "Target reply",
      turnAuthority: globalAuthority,
    });

    const steps = vi.mocked(runAgentStep).mock.calls.map(([step]) => step);
    expect(steps).toHaveLength(3);
    expect(steps.slice(0, 2)).toMatchObject([
      { sessionKey: "global", targetAgentId: "source", lane: "nested:agent:source:global" },
      { sessionKey: "global", targetAgentId: "target", lane: "nested:agent:target:global" },
    ]);
    expect(steps[2]).toMatchObject({ sessionKey: "global", targetAgentId: "target" });
    expect(requireGatewayCall("send").params).toMatchObject({
      agentId: "target",
      sessionKey: "global",
      to: "channel:target-global",
    });
    expect(requireGatewayCall("sessions.list").params).toMatchObject({ agentId: "target" });
  });

  it("keeps custom unscoped endpoints bound to their explicit agents", async () => {
    const requesterSessionKey = "custom-shared-session";
    const targetSessionKey = requesterSessionKey;
    sessionListRows = [
      {
        key: targetSessionKey,
        agentId: "main",
        kind: "other",
        channel: "discord",
        deliveryContext: { channel: "discord", to: "channel:wrong-agent" },
      },
      {
        key: targetSessionKey,
        agentId: "ops",
        kind: "other",
        channel: "discord",
        deliveryContext: { channel: "discord", to: "channel:ops" },
      },
    ];
    const customAuthority = createTestTurnAuthority({
      agentId: "source",
      sessionKey: requesterSessionKey,
    });

    await runSessionsSendA2AFlow({
      targetSessionKey,
      targetAgentId: "ops",
      displayKey: targetSessionKey,
      message: "Test custom-session message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey,
      requesterAgentId: "source",
      requesterChannel: "discord",
      roundOneReply: "Target reply",
      turnAuthority: customAuthority,
    });

    const steps = vi.mocked(runAgentStep).mock.calls.map(([step]) => step);
    expect(steps).toHaveLength(3);
    expect(steps).toMatchObject([
      {
        sessionKey: requesterSessionKey,
        targetAgentId: "source",
        lane: `nested:agent:source:${requesterSessionKey}`,
      },
      {
        sessionKey: targetSessionKey,
        targetAgentId: "ops",
        lane: `nested:agent:ops:${targetSessionKey}`,
      },
      {
        sessionKey: targetSessionKey,
        targetAgentId: "ops",
        lane: `nested:agent:ops:${targetSessionKey}`,
      },
    ]);
    expect(requireGatewayCall("send").params).toMatchObject({
      agentId: "ops",
      sessionKey: targetSessionKey,
      to: "channel:ops",
    });
    expect(requireGatewayCall("sessions.list").params).toMatchObject({ agentId: "ops" });
  });

  it("requires adjacent agents for custom unscoped endpoints", async () => {
    const customAuthority = createTestTurnAuthority({
      agentId: "source",
      sessionKey: "custom-source-session",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "custom-ops-session",
      displayKey: "custom-ops-session",
      message: "Missing target agent",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "custom-source-session",
      requesterAgentId: "source",
      roundOneReply: "Target reply",
      turnAuthority: customAuthority,
    });
    await runSessionsSendA2AFlow({
      targetSessionKey: "custom-ops-session",
      targetAgentId: "ops",
      displayKey: "custom-ops-session",
      message: "Missing requester agent",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "custom-source-session",
      roundOneReply: "Target reply",
      turnAuthority: customAuthority,
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls).toEqual([]);
  });

  it("does not run the announce decider for same-session sends without an announce target", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:main",
      displayKey: "agent:main:main",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterChannel: "qa-channel",
      roundOneReply: "Already delivered through the source message tool",
    });

    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it.each([
    {
      source: "deliveryContext.accountId",
      accountId: "thinker",
      session: {
        key: "agent:main:discord:channel:target-room",
        kind: "group",
        channel: "discord",
        deliveryContext: {
          channel: "discord",
          to: "channel:target-room",
          accountId: "thinker",
        },
      } satisfies GatewaySessionListRow,
    },
    {
      source: "lastAccountId",
      accountId: "scout",
      session: {
        key: "agent:main:discord:channel:target-room",
        kind: "group",
        channel: "discord",
        lastChannel: "discord",
        lastTo: "channel:target-room",
        lastAccountId: "scout",
      } satisfies GatewaySessionListRow,
    },
  ])("uses Discord session $source for announce accountId", async ({ accountId, session }) => {
    sessionListRows = [session];

    await runSessionsSendA2AFlow({
      targetSessionKey: session.key,
      displayKey: session.key,
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
      turnAuthority,
    });

    requireGatewayCall("sessions.list");
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.accountId).toBe(accountId);
  });

  it.each([
    ["missing", undefined],
    ["forged", structuredClone(createTestTurnAuthority())],
  ] as const)(
    "fails closed before announce delivery for %s authority",
    async (_label, authority) => {
      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:main:discord:channel:target-room",
        displayKey: "agent:main:discord:channel:target-room",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        requesterSessionKey: "agent:main:discord:channel:target-room",
        requesterChannel: "discord",
        roundOneReply: "Must remain blocked",
        turnAuthority: authority,
      });

      expect(runtimeIdentityMocks.mintRuntimeIdentity).not.toHaveBeenCalled();
      expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    },
  );

  it.each(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "does not re-inject exact control reply %s into agent-to-agent flow",
    async (roundOneReply) => {
      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:main:discord:group:dev",
        displayKey: "agent:main:discord:group:dev",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 2,
        requesterSessionKey: "agent:main:discord:group:req",
        requesterChannel: "discord",
        roundOneReply,
      });

      expect(runAgentStep).not.toHaveBeenCalled();
      expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    },
  );

  it("does not inject a delayed reply that matches the baseline", async () => {
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "same reply",
      fingerprint: "same-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      baseline: {
        text: "same reply",
        fingerprint: "same-reply",
      },
      waitRunId: "run-delayed",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe("run-delayed");
    expect(
      firstMockArg(vi.mocked(readLatestAssistantReplySnapshot), "assistant reply snapshot")
        .sessionKey,
    ).toBe("agent:main:discord:group:dev");
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("notifies the requester when delayed target delivery fails after acceptance", async () => {
    vi.mocked(waitForAgentRun).mockResolvedValueOnce({
      status: "timeout",
      error:
        "SessionWriteLockTimeoutError: session file locked (timeout 60000ms): pid=43 alive=true",
      pendingError: true,
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      baseline: {
        text: "previous reply",
        fingerprint: "previous-reply",
      },
      waitRunId: "run-lock-timeout",
    });

    expect(readLatestAssistantReplySnapshot).not.toHaveBeenCalled();
    expect(runAgentStep).toHaveBeenCalledOnce();
    expect(firstMockArg(vi.mocked(runAgentStep), "agent step")).toMatchObject({
      sessionKey: "agent:main:discord:group:req",
      sourceSessionKey: "agent:worker:discord:group:dev",
      sourceTool: "sessions_send",
    });
    const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
    expect(stepInput.message).toContain("sessions_send delivery to");
    expect(stepInput.message).toContain("SessionWriteLockTimeoutError");
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("does not notify the requester for waited sends that already returned the error inline", async () => {
    vi.mocked(waitForAgentRun).mockResolvedValueOnce({
      status: "timeout",
      error:
        "SessionWriteLockTimeoutError: session file locked (timeout 60000ms): pid=43 alive=true",
      pendingError: true,
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      waitRunId: "run-lock-timeout-inline",
    });

    expect(readLatestAssistantReplySnapshot).not.toHaveBeenCalled();
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("keeps ordinary delayed target timeouts silent", async () => {
    vi.mocked(waitForAgentRun).mockResolvedValueOnce({
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      waitRunId: "run-still-working",
    });

    expect(readLatestAssistantReplySnapshot).not.toHaveBeenCalled();
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("keeps recoverable delayed wait errors silent", async () => {
    vi.mocked(waitForAgentRun).mockResolvedValueOnce({
      status: "error",
      error: "gateway closed (1006)",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:worker:discord:group:dev",
      displayKey: "agent:worker:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      notifyRequesterOnWaitFailure: true,
      waitRunId: "run-wait-interrupted",
    });

    expect(readLatestAssistantReplySnapshot).not.toHaveBeenCalled();
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("skips requester steps when ping-pong is disabled but still announces from the target", async () => {
    const targetSessionKey = "agent:other:discord:group:ops";
    const cronTurnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "main",
      sessionKey: "agent:main:cron:job:run:abc",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey,
      displayKey: targetSessionKey,
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:main:cron:job:run:abc",
      requesterChannel: "telegram",
      roundOneReply: "Worker completed successfully",
      turnAuthority: cronTurnAuthority,
    });

    expect(runAgentStep).toHaveBeenCalledOnce();
    expect(firstMockArg(vi.mocked(runAgentStep), "agent step")).toMatchObject({
      sessionKey: targetSessionKey,
      message: "Agent-to-agent announce step.",
      turnAuthority: cronTurnAuthority,
    });
  });

  it("does not inject a delayed reply that matches a text-only baseline", async () => {
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "same reply",
      fingerprint: "same-reply-new-fingerprint",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:group:req",
      requesterChannel: "discord",
      baseline: {
        text: "same reply",
      },
      waitRunId: "run-delayed",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe("run-delayed");
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP"])(
    "suppresses exact announce control reply %s before channel delivery",
    async (announceReply) => {
      vi.mocked(runAgentStep).mockResolvedValueOnce(announceReply);

      await runSessionsSendA2AFlow({
        targetSessionKey: "agent:main:discord:group:dev",
        displayKey: "agent:main:discord:group:dev",
        message: "Test message",
        announceTimeoutMs: 10_000,
        maxPingPongTurns: 0,
        roundOneReply: "Worker completed successfully",
      });

      const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
      expect(stepInput.message).toBe("Agent-to-agent announce step.");
      expect(stepInput.transcriptMessage).toBe("");
      expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
    },
  );
});
