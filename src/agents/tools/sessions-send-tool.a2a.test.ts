// sessions_send A2A tests cover announce delivery, same-session replies, delayed
// reply baselines, and channel target/account routing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { readLatestAssistantReplySnapshot, waitForAgentRun } from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import type { SessionListRow } from "./sessions-helpers.js";
import { runSessionsSendA2AFlow, testing } from "./sessions-send-tool.a2a.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../run-wait.js", async (importOriginal) => {
  const { isRecoverableAgentWaitError } = await importOriginal<typeof import("../run-wait.js")>();
  return {
    isRecoverableAgentWaitError,
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

describe("runSessionsSendA2AFlow announce delivery", () => {
  let gatewayCalls: CallGatewayOptions[];
  let sessionListRows: SessionListRow[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    sessionListRows = [];
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
    vi.mocked(runAgentStep).mockResolvedValue("Test announce reply");
    vi.mocked(waitForAgentRun).mockResolvedValue({ status: "ok" });
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValue({
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
    });

    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
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
      requesterChannel: "discord",
      roundOneReply: "Substantive channel reply",
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
    expect(
      firstMockArg(vi.mocked(readLatestAssistantReplySnapshot), "assistant reply snapshot")
        .sessionKey,
    ).toBe("agent:main:discord:channel:target-room");
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

  it("does not direct-deliver a delayed same-session reply without a baseline", async () => {
    // Without a baseline fingerprint, a delayed assistant reply may be stale;
    // avoid direct delivery unless freshness is provable.
    vi.mocked(readLatestAssistantReplySnapshot).mockResolvedValueOnce({
      text: "Maybe stale channel reply",
      fingerprint: "maybe-stale-channel-reply",
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "discord",
      waitRunId: "run-delayed-channel",
    });

    expect(firstMockArg(vi.mocked(waitForAgentRun), "agent run wait").runId).toBe(
      "run-delayed-channel",
    );
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(gatewayCalls.find((call) => call.method === "send")).toBeUndefined();
  });

  it("delivers primaryReply via gateway for same-session sends from a different channel and skips announce", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:channel:target-room",
      displayKey: "agent:main:discord:channel:target-room",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:main:discord:channel:target-room",
      requesterChannel: "webchat",
      roundOneReply: "Substantive channel reply",
    });

    // pre-ping-pong delivery sends primaryReply directly; announce skipped
    expect(runAgentStep).not.toHaveBeenCalled();
    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    if (sendCall) {
      const p = sendCall.params as Record<string, unknown>;
      expect(p.message).toBe("Substantive channel reply");
    }
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
      } satisfies SessionListRow,
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
      } satisfies SessionListRow,
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
    });

    requireGatewayCall("sessions.list");
    const sendCall = requireGatewayCall("send");
    const sendParams = sendCall.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.to).toBe("channel:target-room");
    expect(sendParams.accountId).toBe(accountId);
  });

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

  it("keeps announce gate for unresolvable requester when ping-pong is disabled", async () => {
    const targetSessionKey = "agent:other:discord:group:ops";

    await runSessionsSendA2AFlow({
      targetSessionKey,
      displayKey: targetSessionKey,
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:main:cron:job:run:abc",
      requesterChannel: "telegram",
      roundOneReply: "Worker completed successfully",
    });

    // cron requester unresolvable → no pre-ping-pong delivery
    // announce gate stays active → announce step runs
    expect(runAgentStep).toHaveBeenCalledTimes(1);
    const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
    expect(stepInput.message).toContain("announce");

    // announce reply delivered via gateway send
    const sendCall = gatewayCalls.find((c) => c.method === "send");
    expect(sendCall).toBeDefined();
    if (sendCall) {
      const p = sendCall.params;
      expect(p).toMatchObject({
        message: "Test announce reply",
      });
    }
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK", "ANNOUNCE_SKIP"])(
    "keeps announce gate when no requester session is provided",
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

      // no requesterSessionKey → no pre-ping-pong delivery
      // announce gate stays active → announce step runs
      expect(runAgentStep).toHaveBeenCalledTimes(1);
      const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
      expect(stepInput.message).toContain("announce");

      // announce reply may be suppressed by control tokens
      // (ANNOUNCE_SKIP, NO_REPLY, HEARTBEAT_OK, REPLY_SKIP);
      // gateway send only happens for substantive replies
    },
  );

  it("runs one target ping-pong turn when requester !== target and skips requester round", async () => {
    vi.mocked(runAgentStep).mockResolvedValueOnce("Target second reply");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Request task",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:requester:cron:job:run:abc",
      requesterChannel: "telegram",
      roundOneReply: "Target first reply",
    });

    // requester cron key unresolvable → no pre-ping-pong delivery
    const preSend = gatewayCalls.find(
      (c) => c.method === "send" && c.params?.message === "Target first reply",
    );
    expect(preSend).toBeUndefined();

    // ping-pong: one target turn, requester round skipped by guard
    expect(runAgentStep).toHaveBeenCalledTimes(2);
    const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
    expect(stepInput.sessionKey).toBe("agent:main:discord:group:dev");
    expect(stepInput.message).toBe("Target first reply");

    // announce step ran (guard: no requesterTarget → keep announce gate)
    // announce produced "Test announce reply" → delivered via gateway send
    const announceSend = gatewayCalls.filter((c) => c.method === "send");
    expect(announceSend).toHaveLength(1);
  });

  it("uses requester-derived target for pre-ping-pong delivery when requester session resolves", async () => {
    vi.mocked(runAgentStep).mockResolvedValueOnce("Target second reply");

    // Set up session list so requester session key resolves to Telegram channel
    sessionListRows = [
      {
        key: "agent:requester:telegram:user:6278285192",
        kind: "dm",
        channel: "telegram",
        lastChannel: "telegram",
        lastTo: "6278285192",
        lastAccountId: "primary",
      } satisfies SessionListRow,
    ];

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Request task",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:requester:telegram:user:6278285192",
      requesterChannel: "telegram",
      roundOneReply: "Target first reply",
    });

    // pre-ping-pong delivery should use requester session route (Telegram), not target (Discord)
    const primarySend = gatewayCalls.find(
      (c) => c.method === "send" && c.params?.message === "Target first reply",
    );
    expect(primarySend).toBeDefined();
    if (primarySend) {
      const p = primarySend.params as Record<string, unknown>;
      expect(p.channel).toBe("telegram");
      expect(p.to).toBe("6278285192");
    }

    // ping-pong: one target turn
    expect(runAgentStep).toHaveBeenCalledTimes(1);
    const stepInput = firstMockArg(vi.mocked(runAgentStep), "agent step");
    expect(stepInput.sessionKey).toBe("agent:main:discord:group:dev");

    // announce skipped
    expect(gatewayCalls.filter((c) => c.method === "send")).toHaveLength(1);
  });
});
