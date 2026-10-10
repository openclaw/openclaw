// Strict cron announcement transport tests cover scheduler-authorized alert delivery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as deliveryQueue from "../infra/delivery-queue-sqlite.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../infra/outbound/deliver-types.js";
import { makeJob } from "./isolated-agent.test-harness.js";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({ kind: "identity" }),
  buildOutboundSessionContext: vi.fn().mockReturnValue({ kind: "session" }),
  createOutboundSendDeps: vi.fn().mockReturnValue({ kind: "deps" }),
  appendAssistantMessageToSessionTranscript: vi.fn().mockResolvedValue({ ok: true }),
  resolveOutboundSessionRoute: vi.fn(),
  ensureOutboundSessionEntry: vi.fn(),
  loadCronSessionEntryLatest: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));
vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));
vi.mock("../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: mocks.resolveAgentOutboundIdentity,
}));
vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: mocks.buildOutboundSessionContext,
}));
vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: mocks.createOutboundSendDeps,
}));
vi.mock("../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
  ensureOutboundSessionEntry: mocks.ensureOutboundSessionEntry,
}));
vi.mock("../config/sessions/transcript.runtime.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));
vi.mock("./isolated-agent/session.js", () => ({
  loadCronSessionEntryLatest: mocks.loadCronSessionEntryLatest,
}));

const { sendCronAnnouncePayloadStrict } = await import("./delivery.js");

function send(overrides: Partial<Parameters<typeof sendCronAnnouncePayloadStrict>[0]> = {}) {
  return sendCronAnnouncePayloadStrict({
    deps: {} as never,
    cfg: {},
    agentId: "main",
    jobId: "job-1",
    target: { channel: "telegram", to: "123" },
    payload: { text: "Automation failed" },
    abortSignal: new AbortController().signal,
    ...overrides,
  });
}

describe("sendCronAnnouncePayloadStrict", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(deliveryQueue, "inspectDeliveryQueueReceipt").mockResolvedValue({
      status: undefined,
      pendingEntry: null,
    });
    mocks.loadCronSessionEntryLatest.mockReset().mockReturnValue({
      sessionId: "destination-session",
      updatedAt: 1,
    });
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
      threadId: 42,
      mode: "explicit",
    });
    mocks.deliverOutboundPayloads.mockReset().mockResolvedValue([{ ok: true }]);
    mocks.resolveOutboundSessionRoute.mockReset().mockResolvedValue({
      sessionKey: "agent:main:telegram:group:123:topic:42",
      baseSessionKey: "agent:main:telegram:group:123",
    });
  });

  it.each(["topic", "global"])(
    "sends multiple payloads without writing the %s recipient conversation",
    async (scope) => {
      const job = makeJob({ kind: "command", argv: ["/bin/echo", "Readiness 65 today"] });
      mocks.resolveOutboundSessionRoute.mockRejectedValue(
        new Error("notification must not resolve a model conversation"),
      );
      mocks.loadCronSessionEntryLatest.mockImplementation(() => {
        throw new Error("notification must not read a model conversation");
      });
      const payloads = [
        { text: "Readiness 65 today" },
        { mediaUrl: "https://example.test/chart.png" },
      ];
      const result = await send({
        cfg: scope === "global" ? { session: { scope: "global" } } : {},
        jobId: job.id,
        target: { channel: "telegram", to: "123", threadId: 42 },
        payload: payloads,
        completion: { job, runStartedAt: 1000, deliveryAttemptFence: null },
      });
      expect(result).toEqual({ status: "sent" });
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads,
          deliveryIntentId: "cron-direct-delivery:v1:cron:job-1:1000:telegram:bot-a:123:42",
        }),
        undefined,
      );
      expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
      expect(mocks.ensureOutboundSessionEntry).not.toHaveBeenCalled();
      expect(mocks.loadCronSessionEntryLatest).not.toHaveBeenCalled();
      expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    },
  );

  it("does not begin delivery when target resolution settles after cancellation", async () => {
    let resolvePendingTarget: (value: unknown) => void = () => {};
    mocks.resolveDeliveryTarget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePendingTarget = resolve;
        }),
    );
    const abortController = new AbortController();
    const delivery = send({
      abortSignal: abortController.signal,
    });

    abortController.abort(new Error("delivery deadline exceeded"));
    resolvePendingTarget({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
      mode: "explicit",
    });

    await expect(delivery).rejects.toThrow("delivery deadline exceeded");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("reports the first recipient result before later delivery work settles", async () => {
    let releaseDelivery = () => {};
    const pendingDelivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let reportFirstResult = () => {};
    const firstResult = new Promise<void>((resolve) => {
      reportFirstResult = resolve;
    });
    const delivered = { channel: "telegram" as const, messageId: "delivered-first" };
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async (params: { onDeliveryResult?: (result: typeof delivered) => Promise<void> | void }) => {
        await params.onDeliveryResult?.(delivered);
        reportFirstResult();
        await pendingDelivery;
        return [delivered];
      },
    );
    const onDeliveryAttempt = vi.fn();
    const delivery = send({
      target: { channel: "telegram", to: "123", accountId: "bot-a" },
      onDeliveryAttempt,
    });

    await firstResult;
    try {
      expect(onDeliveryAttempt).toHaveBeenLastCalledWith(true);
    } finally {
      releaseDelivery();
      await delivery;
    }
    expect(onDeliveryAttempt).toHaveBeenLastCalledWith(true);
    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "main",
      { channel: "telegram", to: "123", accountId: "bot-a" },
      undefined,
    );
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      sessionKey: "cron:job-1:failure",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        accountId: "bot-a",
        threadId: 42,
        payloads: [{ text: "Automation failed" }],
        bestEffort: false,
      }),
      undefined,
    );
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "no_visible_result", recipientReached: false },
    { reason: "cancelled_by_message_sending_hook", recipientReached: false },
    { reason: "adapter_returned_no_identity", recipientReached: true },
  ] as const)(
    "preserves terminal $reason suppression and authoritative recipient reach",
    async ({ reason, recipientReached }) => {
      mocks.deliverOutboundPayloads.mockImplementationOnce(
        async (params: { onPayloadDeliveryOutcome?: (outcome: unknown) => void }) => {
          if (reason !== "no_visible_result") {
            params.onPayloadDeliveryOutcome?.({ index: 0, status: "suppressed", reason });
          }
          return [];
        },
      );
      const onDeliveryAttempt = vi.fn();

      const result = await send({
        payload: { text: "Scheduled result" },
        onDeliveryAttempt,
      });

      expect(result).toEqual({ status: "suppressed", reason });
      expect(onDeliveryAttempt).toHaveBeenCalledExactlyOnceWith(recipientReached);
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    },
  );

  it.each(["raw-partial", "wrapped-partial", "failed-after-send"] as const)(
    "preserves recipient-reached evidence across a %s failure",
    async (failureKind) => {
      const rejectedChunk = new PlatformMessageNotDispatchedError(
        "second chunk was never dispatched",
        {
          cause: Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
            syscall: "connect",
          }),
        },
      );
      const firstChunk = { channel: "telegram" as const, messageId: "already-delivered" };
      const deliveryError =
        failureKind === "wrapped-partial"
          ? new OutboundDeliveryError("delivery failed after the first chunk", {
              cause: rejectedChunk,
              results: [firstChunk],
              stage: "platform_send",
            })
          : rejectedChunk;
      mocks.deliverOutboundPayloads.mockImplementationOnce(
        async (params: { onPayloadDeliveryOutcome?: (outcome: unknown) => void }) => {
          if (failureKind === "wrapped-partial") {
            throw deliveryError;
          }
          params.onPayloadDeliveryOutcome?.({
            index: 0,
            status: "failed",
            error: deliveryError,
            sentBeforeError: true,
            stage: "platform_send",
          });
          return failureKind === "raw-partial" ? [firstChunk] : [];
        },
      );
      const onDeliveryAttempt = vi.fn();

      await expect(
        send({
          onDeliveryAttempt,
        }),
      ).rejects.toThrow(deliveryError.message);

      expect(onDeliveryAttempt).toHaveBeenLastCalledWith(true);
      expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "target resolution",
      arrange: () =>
        mocks.resolveDeliveryTarget.mockResolvedValueOnce({
          ok: false,
          error: new Error("target unavailable"),
        }),
      error: "target unavailable",
    },
    {
      name: "channel delivery",
      arrange: () => mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("send failed")),
      error: "send failed",
    },
  ])("rejects $name failures", async ({ arrange, error }) => {
    arrange();

    await expect(send({})).rejects.toThrow(error);
  });
});
