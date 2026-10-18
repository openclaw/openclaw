// Strict cron announcement transport tests cover scheduler-authorized alert delivery.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as deliveryQueue from "../infra/delivery-queue-sqlite.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../infra/outbound/deliver-types.js";
import type { DeliverOutboundPayloadsParams } from "../infra/outbound/deliver.js";
import { sendCronAnnouncePayloadStrict } from "./delivery.js";
import { makeJob } from "./isolated-agent.test-harness.js";

const { deliver, session } = vi.hoisted(() => ({
  deliver: vi.fn(),
  session: vi.fn().mockReturnValue({ kind: "session" }),
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliver,
  deliverOutboundPayloadsInternal: deliver,
}));
vi.mock("../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: () => ({ kind: "identity" }),
}));
vi.mock("../infra/outbound/session-context.js", () => ({ buildOutboundSessionContext: session }));
vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: () => ({ kind: "deps" }),
}));

const destination = { channel: "telegram", to: "123", accountId: "bot-a", threadId: 42 };

function send(overrides: Partial<Parameters<typeof sendCronAnnouncePayloadStrict>[0]> = {}) {
  return sendCronAnnouncePayloadStrict({
    deps: {},
    cfg: {},
    agentId: "main",
    jobId: "job-1",
    target: destination,
    payload: { text: "Automation failed" },
    abortSignal: new AbortController().signal,
    ...overrides,
  });
}

function notDispatched(message: string) {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
    syscall: "connect",
  });
  return new PlatformMessageNotDispatchedError(message, { cause });
}

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
  deliver.mockReset().mockImplementation(async (params: DeliverOutboundPayloadsParams) => {
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
  const payloads = [{ text: "Readiness 65 today" }, { mediaUrl: "https://example.test/chart.png" }];
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
  expect(deliver).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      ...destination,
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
  deliver.mockRejectedValueOnce(notDispatched("connect ECONNREFUSED"));
  const result = send({ abortSignal: signal });
  await vi.runAllTimersAsync();
  await expect(result).resolves.toEqual({
    status: "sent",
    payloads: [{ text: "Automation failed", mediaUrls: [] }],
  });
  expect(deliver).toHaveBeenCalledTimes(2);
  for (const [request] of deliver.mock.calls) {
    expect(request.abortSignal).toBe(signal);
  }
});

it.each([
  ["read ECONNRESET after send", false, 1],
  ["delivery deadline exceeded", true, 0],
] as const)("does not retry %s", async (message, cancelled, attempts) => {
  const error = cancelled
    ? new Error(message)
    : Object.assign(new Error(message), { code: "ECONNRESET" });
  if (!cancelled) {
    deliver.mockRejectedValueOnce(error);
  }
  await expect(send(cancelled ? { abortSignal: AbortSignal.abort(error) } : {})).rejects.toThrow(
    message,
  );
  expect(deliver).toHaveBeenCalledTimes(attempts);
});

it("reports the first recipient result before later delivery work settles", async () => {
  const pendingDelivery = createDeferred();
  const firstResult = createDeferred();
  const delivered = { channel: "telegram" as const, messageId: "delivered-first" };
  deliver.mockImplementationOnce(async (params: DeliverOutboundPayloadsParams) => {
    await params.onDeliveryResult?.(delivered);
    firstResult.resolve();
    await pendingDelivery.promise;
    return [delivered];
  });
  const onDeliveryAttempt = vi.fn();
  const delivery = send({ onDeliveryAttempt });

  await firstResult.promise;
  try {
    expect(onDeliveryAttempt).toHaveBeenLastCalledWith(true);
  } finally {
    pendingDelivery.resolve();
    await delivery;
  }
  expect(onDeliveryAttempt).toHaveBeenLastCalledWith(true);
  expect(session).toHaveBeenCalledWith({
    cfg: {},
    agentId: "main",
    sessionKey: "cron:job-1:failure",
  });
});

it.each([
  { reason: "no_visible_result", recipientReached: false },
  { reason: "cancelled_by_message_sending_hook", recipientReached: false },
  { reason: "adapter_returned_no_identity", recipientReached: true },
] as const)(
  "preserves terminal $reason suppression and authoritative recipient reach",
  async ({ reason, recipientReached }) => {
    deliver.mockImplementationOnce(async (params: DeliverOutboundPayloadsParams) => {
      if (reason !== "no_visible_result") {
        params.onPayloadDeliveryOutcome?.({ index: 0, status: "suppressed", reason });
      }
      return [];
    });
    const onDeliveryAttempt = vi.fn();

    const result = await send({ onDeliveryAttempt });

    expect(result).toEqual({ status: "suppressed", reason });
    expect(onDeliveryAttempt).toHaveBeenCalledExactlyOnceWith(recipientReached);
    expect(deliver).toHaveBeenCalledOnce();
  },
);

it.each(["raw-partial", "wrapped-partial", "failed-after-send"] as const)(
  "preserves recipient-reached evidence across a %s failure",
  async (failureKind) => {
    const rejectedChunk = notDispatched("second chunk was never dispatched");
    const firstChunk = { channel: "telegram" as const, messageId: "already-delivered" };
    const deliveryError =
      failureKind === "wrapped-partial"
        ? new OutboundDeliveryError("delivery failed after the first chunk", {
            cause: rejectedChunk,
            results: [firstChunk],
            stage: "platform_send",
          })
        : rejectedChunk;
    deliver.mockImplementationOnce(async (params: DeliverOutboundPayloadsParams) => {
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
    });
    const onDeliveryAttempt = vi.fn();

    await expect(send({ onDeliveryAttempt })).rejects.toThrow(deliveryError.message);

    expect(onDeliveryAttempt).toHaveBeenLastCalledWith(true);
    expect(deliver).toHaveBeenCalledOnce();
  },
);
