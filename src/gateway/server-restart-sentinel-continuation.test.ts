import "./server-restart-sentinel.test-harness.js";
import { describe, expect, it } from "vitest";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  createRestartSentinelTestFixture,
  sessionFixture,
  type LoadedSessionEntry,
} from "./server-restart-sentinel-fixtures.test-support.js";
import {
  expectRecordFields,
  lastMockCallArg,
  expectMockCallFields,
} from "./server-restart-sentinel.test-support.js";

describe("restart continuation delivery", () => {
  const fixture = createRestartSentinelTestFixture();
  const {
    mocks,
    recoverPendingRestartContinuationDeliveries,
    settleQueuedSessionDelivery,
    expectContinuationDispatchFields,
    expectQueueContext,
    mockRestartContinuation,
    setNoticeOwner,
    wakeRestartSentinel,
  } = fixture;
  it("settles recovered deliveries before cron cleanup", async () => {
    await recoverPendingRestartContinuationDeliveries({
      deps: {} as never,
      queueContext: fixture.queueContext,
    });

    const recovery = mocks.recoverPendingSessionDeliveries.mock.calls[0]?.[0];
    expect(recovery?.onSettled).toBe(settleQueuedSessionDelivery);
    const entry = {
      id: "correlated-completion-1",
      kind: "agentTurn",
      sessionKey: "agent:main:main",
      message: "retained completion",
      messageId: "completion-1",
      enqueuedAt: 1,
      retryCount: 0,
    } as const;
    await recovery?.onSettled?.(entry, "recovered", fixture.queueContext);

    expect(mocks.removeCronRunContinuationSessionIfIdle).toHaveBeenCalledWith(
      entry.sessionKey,
      entry.id,
      fixture.queueContext,
    );
    expect(mocks.settleCorrelatedSubagentDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeCronRunContinuationSessionIfIdle.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("runs agentTurn continuation internally after the restart notice without routed final delivery", async () => {
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "Reply with exactly: Yay! I did it!",
      },
      "thread-42",
    );
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.turnAdoptionLifecycle?.onAdopted();
      await params.deliver({
        text: "done",
        replyToId: "restart-sentinel:agent:main:main:agentTurn:123",
      });
    });

    await wakeRestartSentinel();

    expectMockCallFields(mocks.enqueueDeliveryOnce, {
      payloads: [{ text: "restart message" }],
      threadId: "thread-42",
    });
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(1);
    expect(mocks.markSessionDeliveryAttemptStarted).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), kind: "agentTurn" }),
      expectQueueContext(),
    );
    expectContinuationDispatchFields(
      {
        channel: "whatsapp",
        accountId: "acct-2",
        routeSessionKey: "agent:main:main",
        replyOptions: expect.objectContaining({ sourceReplyDeliveryMode: "message_tool_only" }),
      },
      {
        Body: "Reply with exactly: Yay! I did it!",
        BodyForAgent: "Reply with exactly: Yay! I did it!",
        BodyForCommands: "",
        CommandBody: "",
        CommandAuthorized: true,
        GatewayClientScopes: ["operator.admin"],
        GatewayClientCaps: [],
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "whatsapp",
          sourceTool: "restart-sentinel",
        },
        SessionKey: "agent:main:main",
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "+15550002",
        ExplicitDeliverRoute: false,
        MessageThreadId: "thread-42",
      },
    );
    const deliveredContinuationReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredContinuationReply).toBe(false);
  });

  it("does not dispatch a queued agentTurn continuation after the session key changes", async () => {
    const activeEntry: LoadedSessionEntry = sessionFixture(
      "agent:main:main",
      {
        sessionId: "old-session-id",
        updatedAt: Date.now(),
      },
      { cfg: { commands: { ownerAllowFrom: ["+15550002"] } } },
    );
    const replacementEntry: LoadedSessionEntry = sessionFixture(
      "agent:main:main",
      {
        sessionId: "new-session-id",
        updatedAt: Date.now(),
        status: "done",
        endedAt: Date.now() - 1_000,
      },
      { cfg: { commands: { ownerAllowFrom: ["+15550002"] } } },
    );
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "continue after restart",
      },
      "thread-42",
    );
    mocks.loadSessionEntry.mockReturnValueOnce(activeEntry).mockReturnValue(replacementEntry);

    await wakeRestartSentinel();

    expect(mocks.enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
      "continue after restart",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        contextKey: `task:restart-sentinel:${await mocks.enqueueSessionDelivery.mock.results[0]!.value}`,
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
          threadId: "thread-42",
        },
      }),
    );
    expect(mocks.logWarn).toHaveBeenCalledWith("restart continuation skipped: session changed", {
      sessionKey: "agent:main:main",
      queueId: expect.any(String),
      expectedSessionId: "old-session-id",
      actualSessionId: "new-session-id",
    });
  });

  it("authorizes routed agentTurn continuations while preserving Telegram topic routing", async () => {
    mocks.readRestartSentinel.mockResolvedValue({
      payload: {
        sessionKey: "agent:main:telegram:group:-1003826723328:topic:13757",
        ts: 123,
        continuation: {
          kind: "agentTurn",
          message: "continue in topic",
        },
      },
    } as unknown as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
    mocks.parseSessionThreadInfo.mockReturnValue({
      baseSessionKey: "agent:main:telegram:group:-1003826723328",
      threadId: "13757",
    });
    mocks.loadSessionEntry.mockReturnValue(
      sessionFixture("agent:main:telegram:group:-1003826723328:topic:13757", {
        sessionId: "agent:main:telegram:group:-1003826723328:topic:13757",
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram" },
          origin: { provider: "telegram", chatType: "group" },
        }),
      }),
    );
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "telegram",
      to: "-1003826723328:topic:13757",
      accountId: "default",
      threadId: 13757,
    });
    mocks.resolveOutboundTarget.mockReturnValue({
      ok: true as const,
      to: "-1003826723328:topic:13757",
    });
    setNoticeOwner("-1003826723328:topic:13757");

    await wakeRestartSentinel();

    expectContinuationDispatchFields(
      {
        channel: "telegram",
        accountId: "default",
        routeSessionKey: "agent:main:telegram:group:-1003826723328:topic:13757",
        replyOptions: expect.objectContaining({ sourceReplyDeliveryMode: "message_tool_only" }),
      },
      {
        Body: "continue in topic",
        CommandAuthorized: true,
        GatewayClientScopes: ["operator.admin"],
        GatewayClientCaps: [],
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "telegram",
          sourceTool: "restart-sentinel",
        },
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "group",
        OriginatingChannel: "telegram",
        OriginatingTo: "-1003826723328:topic:13757",
        ExplicitDeliverRoute: false,
        MessageThreadId: "13757",
      },
    );
  });

  it("preserves derived reply transport ids in internal continuation context", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "WhatsApp",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      threading: {
        resolveReplyTransport: ({ threadId }: { threadId?: string | number | null }) => ({
          replyToId: threadId != null ? `reply:${String(threadId)}` : undefined,
          threadId: null,
        }),
      },
    });
    mockRestartContinuation(
      {
        kind: "agentTurn",
        message: "continue",
      },
      "thread-42",
    );
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(async (params) => {
      await params.deliver({
        text: "done",
        replyToId: "restart-sentinel:agent:main:main:agentTurn:123",
      });
    });

    await wakeRestartSentinel();

    expectContinuationDispatchFields(
      {},
      {
        ReplyToId: "reply:thread-42",
        MessageThreadId: undefined,
      },
    );
    const deliveredContinuationReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredContinuationReply).toBe(false);
  });

  it("logs and continues when continuation dispatch reports a delivery error", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.recordInboundSessionAndDispatchReply.mockImplementationOnce(
      async (params: { onDispatchError: (err: unknown, info: { kind: string }) => void }) => {
        params.onDispatchError(new Error("route failed"), { kind: "final" });
      },
    );

    await wakeRestartSentinel();

    expect(mocks.logWarn.mock.calls[0]).toEqual([
      "restart continuation dispatch failed during final: Error: route failed",
      {
        sessionKey: "agent:main:main",
      },
    ]);
    expect(mocks.logWarn.mock.calls[1]?.[0]).toMatch(
      /^restart continuation: retry failed for entry [0-9a-f]{64}: route failed$/,
    );
  });

  it("retries restart continuations when the previous run is still shutting down", async () => {
    const busyReply = "⚠️ Previous run is still shutting down. Please try again in a moment.";
    let attempt = 0;
    mockRestartContinuation({ kind: "agentTurn", message: "continue" }, undefined, 123);
    mocks.recordInboundSessionAndDispatchReply.mockImplementation(async (params) => {
      attempt += 1;
      if (attempt <= 2) {
        await params.deliver({ text: busyReply });
        return;
      }
      await params.deliver({
        text: "done",
        replyToId: String(params.ctxPayload.MessageSid),
      });
    });

    await wakeRestartSentinel();

    expectMockCallFields(mocks.enqueueSessionDelivery, {
      maxRetries: 20,
    });
    expect(mocks.recordInboundSessionAndDispatchReply).toHaveBeenCalledTimes(3);
    expectContinuationDispatchFields(
      {},
      { MessageSid: "restart-sentinel:agent:main:main:agentTurn:123" },
      0,
    );
    expectContinuationDispatchFields(
      {},
      { MessageSid: "restart-sentinel:agent:main:main:agentTurn:123:retry:2" },
      2,
    );
    const deliveredBusyReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === busyReply) === true);
    expect(deliveredBusyReply).toBe(false);
    const deliveredFinalReply = (
      mocks.deliverOutboundPayloads.mock.calls as unknown as Array<
        [{ payloads?: Array<{ text?: string }> }]
      >
    ).some(([call]) => call.payloads?.some((payload) => payload.text === "done") === true);
    expect(deliveredFinalReply).toBe(false);
    expectRecordFields(lastMockCallArg(mocks.deliverOutboundPayloads), {
      payloads: [{ text: "restart message" }],
    });
    expect(mocks.logWarn).toHaveBeenCalledTimes(2);
    for (const [message] of mocks.logWarn.mock.calls) {
      expect(message).toMatch(
        /^restart continuation: retry failed for entry [0-9a-f]{64}: restart continuation deferred because previous run is still shutting down$/,
      );
    }
  });

  it("records an unroutable continuation without a diagnostic wake", async () => {
    mockRestartContinuation({ kind: "agentTurn", message: "continue" }, "thread-42");
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error("missing route"),
    });

    await wakeRestartSentinel();

    expect(mocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(mocks.enqueueSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.recordInboundSessionAndDispatchReply).not.toHaveBeenCalled();
    expect(mocks.clearSentinel).toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("lifecycle notice skipped: no delivery target", {
      runId: undefined,
    });
  });

  it("keeps the sentinel file when durable continuation handoff fails", async () => {
    mockRestartContinuation({
      kind: "agentTurn",
      message: "continue",
    });
    mocks.enqueueSessionDelivery.mockRejectedValueOnce(new Error("queue write failed"));

    await wakeRestartSentinel();

    expect(mocks.clearSentinel).not.toHaveBeenCalled();
    expect(mocks.drainPendingSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("startup task failed", {
      source: "restart-sentinel",
      sessionKey: "agent:main:main",
      reason: "queue write failed",
    });
  });
});
