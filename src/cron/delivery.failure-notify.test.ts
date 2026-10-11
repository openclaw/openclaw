// Strict cron announcement transport tests cover scheduler-authorized alert delivery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as deliveryQueue from "../infra/delivery-queue-sqlite.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../infra/outbound/deliver-types.js";
import type { DeliverOutboundPayloadsParams } from "../infra/outbound/deliver.js";
import { sendCronAnnouncePayloadStrict } from "./delivery.js";
import { makeJob } from "./isolated-agent.test-harness.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({ kind: "identity" }),
  buildOutboundSessionContext: vi.fn().mockReturnValue({ kind: "session" }),
  createOutboundSendDeps: vi.fn().mockReturnValue({ kind: "deps" }),
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

function send(overrides: Partial<Parameters<typeof sendCronAnnouncePayloadStrict>[0]> = {}) {
  return sendCronAnnouncePayloadStrict({
    deps: {},
    cfg: {},
    agentId: "main",
    jobId: "job-1",
    target: { channel: "telegram", to: "123", accountId: "bot-a", threadId: 42 },
    payload: { text: "Automation failed" },
    abortSignal: new AbortController().signal,
    ...overrides,
  });
}

describe("sendCronAnnouncePayloadStrict", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(deliveryQueue, "inspectDeliveryQueueReceipt").mockResolvedValue({
      status: undefined,
      pendingEntry: null,
    });
    mocks.deliverOutboundPayloads
      .mockReset()
      .mockImplementation(async (params: DeliverOutboundPayloadsParams) => {
        for (const payload of params.payloads) {
          params.onDeliveredPayload?.({
            text: payload.text ?? "",
            mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
          });
        }
        return [{ ok: true }];
      });
  });

  it("sends all prepared payloads under one destination-scoped intent", async () => {
    const job = makeJob({ kind: "command", argv: ["/bin/echo", "Readiness 65 today"] });
    const payloads = [
      { text: "Readiness 65 today" },
      { mediaUrl: "https://example.test/chart.png" },
    ];
    const result = await send({
      jobId: job.id,
      payload: payloads,
      completion: { job, runStartedAt: 1000, deliveryAttemptFence: null },
    });
    expect(result).toEqual({
      status: "sent",
      payloads: [
        { text: "Readiness 65 today", mediaUrls: [] },
        { text: "", mediaUrls: ["https://example.test/chart.png"] },
      ],
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        accountId: "bot-a",
        threadId: 42,
        payloads,
        bestEffort: false,
        deliveryIntentId: "cron-direct-delivery:v1:cron:job-1:1000:telegram:bot-a:123:42",
      }),
      undefined,
    );
  });

  it("retries a proven not-dispatched failure through the notification sender", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const rejected = new PlatformMessageNotDispatchedError("connect ECONNREFUSED", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
        syscall: "connect",
      }),
    });
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(rejected);
    const result = send({ abortSignal: signal });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({
      status: "sent",
      payloads: [{ text: "Automation failed", mediaUrls: [] }],
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.deliverOutboundPayloads.mock.calls) {
      expect(request.abortSignal).toBe(signal);
    }
  });

  it("does not retry an uncertain platform send", async () => {
    const uncertain = Object.assign(new Error("read ECONNRESET after send"), {
      code: "ECONNRESET",
    });
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(uncertain);
    await expect(send()).rejects.toThrow("read ECONNRESET after send");
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
  });

  it("does not begin delivery after cancellation", async () => {
    await expect(
      send({ abortSignal: AbortSignal.abort(new Error("delivery deadline exceeded")) }),
    ).rejects.toThrow("delivery deadline exceeded");
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
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      sessionKey: undefined,
    });
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
});
