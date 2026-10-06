import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/delivery-result.js";
import { createDirectPendingFinalCustody } from "../../channels/turn/direct-delivery-custody.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import {
  createOutboundPayloadPlan,
  createStructuredOutboundPayloadPlan,
} from "../../infra/outbound/payloads.js";
import { preserveReplyPayloadMediaSelectionCore } from "../../infra/outbound/reply-media-entries.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { captureDeliveredTranscriptMirror } from "./dispatch-from-config.transcript.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
  prepareReplyPayloadForDispatcher,
} from "./reply-dispatcher.js";

function planReply(payload: ReplyPayload): OutboundPayloadPlan {
  const [plan] = createStructuredOutboundPayloadPlan([payload]);
  if (!plan) {
    throw new Error("expected a sendable prepared reply");
  }
  return plan;
}

function sendFinal(
  dispatcher: ReturnType<typeof createReplyDispatcher>,
  operation: "raw" | "prepared",
  payload: ReplyPayload,
) {
  return operation === "raw"
    ? dispatcher.sendFinalReply(payload)
    : dispatcher.sendPreparedReply("final", planReply(payload));
}

async function makePendingFinalFixture() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dispatcher-pending-final-"));
  const storePath = path.join(tmpDir, "sessions.json");
  const sessionKey = "agent:main:telegram:direct:123";
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      sessionId: "session-1",
      updatedAt: Date.now(),
      pendingFinalDelivery: {
        kind: "replayable",
        text: "final answer",
        createdAt: Date.now(),
        intentId: "intent-1",
        deliveries: [{ id: "delivery-1", state: "prepared" }],
      },
    },
  );
  const payload = setReplyPayloadMetadata(
    { text: "final answer" },
    {
      pendingFinalDeliveryCompletion: {
        deliveryId: "delivery-1",
        intentId: "intent-1",
        sessionId: "session-1",
        sessionKey,
        storePath,
      },
    },
  );
  return { payload, sessionKey, storePath, tmpDir };
}

describe("beforeDeliver in reply dispatcher", () => {
  it.each(["raw", "prepared"] as const)(
    "retains an in-place media selection through %s dispatch recovery",
    async (operation) => {
      const delivered: ReplyPayload[] = [];
      const deliver = async (payload: ReplyPayload) => {
        delivered.push(
          preserveReplyPayloadMediaSelectionCore(payload, {
            ...payload,
            text: "Recovered full text",
            mediaUrls: ["/tmp/rejected.png", "/tmp/selected.png"],
          }),
        );
      };
      const dispatcher = createReplyDispatcher({
        beforeDeliver: (payload) => {
          payload.mediaUrl = undefined;
          payload.mediaUrls?.splice(0, 1);
          payload.attachments?.splice(0, 1);
          return payload;
        },
        deliver,
        deliverPrepared: async (plan) => deliver(plan.payload),
      });
      expect(
        sendFinal(dispatcher, operation, {
          text: "Short answer",
          mediaUrls: ["/tmp/rejected.png", "/tmp/selected.png"],
          attachments: [{ name: "rejected" }, { name: "selected" }],
        }),
      ).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      expect(delivered).toEqual([
        expect.objectContaining({
          text: "Recovered full text",
          mediaUrls: ["/tmp/selected.png"],
          attachments: [{ name: "selected" }],
        }),
      ]);
    },
  );

  it.each(["[[reply_to:example-id]]` literally.", "[[audio_as_voice]]` literally."])(
    "preserves prepared literal %s and rebuilds projections after modifiers",
    async (text) => {
      const delivered: OutboundPayloadPlan[] = [];
      const deliver = vi.fn(async () => {});
      const dispatcher = createReplyDispatcher({
        responsePrefix: "[bot]",
        beforeDeliver: async (payload) => ({
          ...payload,
          text: `${payload.text} Updated.`,
          mediaUrl: undefined,
          mediaUrls: ["/tmp/updated.png"],
        }),
        deliver,
        deliverPrepared: async (plan) => {
          delivered.push(plan);
        },
      });
      const plan = { ...planReply({ text, mediaUrl: "/tmp/original.png" }), sourceIndex: 3 };
      const outcome = captureReplyDispatchDeliveryOutcome(plan.payload);

      expect(dispatcher.sendPreparedReply("block", plan)).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(deliver).not.toHaveBeenCalled();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        sourceIndex: 3,
        payload: { text: `[bot] ${text} Updated.` },
        parts: { text: `[bot] ${text} Updated.`, mediaUrls: ["/tmp/updated.png"] },
      });
      expect(delivered[0]?.payload.replyToId).toBeUndefined();
      expect(delivered[0]?.payload.audioAsVoice).toBeUndefined();
      expect(outcome.isTracked()).toBe(true);
      await expect(outcome.promise).resolves.toBe("delivered");
    },
  );

  it.each(["tool", "block", "final"] as const)(
    "retains raw %s delivery when prepared egress is available",
    async (kind) => {
      const delivered: ReplyPayload[] = [];
      const deliverPrepared = vi.fn(async () => {});
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(...createOutboundPayloadPlan([payload]).map((plan) => plan.payload));
        },
        deliverPrepared,
      });
      const send = {
        tool: dispatcher.sendToolResult,
        block: dispatcher.sendBlockReply,
        final: dispatcher.sendFinalReply,
      }[kind];

      expect(send({ text: "[[reply_to:real-id]] Raw reply" })).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(deliverPrepared).not.toHaveBeenCalled();
      expect(delivered).toMatchObject([{ text: "Raw reply", replyToId: "real-id" }]);
    },
  );

  it.each(["raw", "prepared"] as const)(
    "preserves %s hook rewrites through legacy egress",
    async (operation) => {
      const delivered: ReplyPayload[] = [];
      const indices: Array<number | undefined> = [];
      const dispatcher = createReplyDispatcher({
        beforeDeliver: async (payload) =>
          operation === "raw"
            ? { text: "rewritten" }
            : { ...payload, text: `${payload.text} Updated.` },
        deliver: async (payload, info) => {
          delivered.push(payload);
          indices.push(info.assistantMessageIndex);
        },
      });
      if (operation === "prepared") {
        expect(
          dispatcher.sendPreparedReply(
            "final",
            planReply({ text: "[[reply_to:example-id]]` literally." }),
          ),
        ).toBe(true);
      } else {
        dispatcher.sendBlockReply(
          setReplyPayloadMetadata({ text: "original" }, { assistantMessageIndex: 12 }),
        );
      }
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      if (operation === "prepared") {
        expect(delivered).toMatchObject([{ text: "[[reply_to:example-id]]` literally. Updated." }]);
        expect(delivered[0]?.replyToId).toBeUndefined();
      } else {
        expect(delivered.map(getReplyPayloadMetadata)).toMatchObject([
          { assistantMessageIndex: 12 },
        ]);
        expect(indices).toEqual([12]);
      }
    },
  );

  it("keeps prepared capture owners separate after hook rewrites on one dispatcher", async () => {
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      beforeDeliver: async (payload) => ({ ...payload, text: `Edited ${payload.text}` }),
      deliver: async () => {
        throw new Error("expected prepared delivery");
      },
      deliverPrepared: async (plan) => {
        delivered.push(plan.parts.text);
      },
    });
    const captures = ["first", "second"].map((text) => {
      const captureToken = {};
      const metadata = { sessionKey: "agent:test:session", idempotencyKey: "source-reply", text };
      const capture = captureDeliveredTranscriptMirror({ dispatcher, metadata, captureToken });
      const plan = planReply(
        setReplyPayloadMetadata(
          { text },
          { finalDeliveryCapture: captureToken, sourceReplyTranscriptMirror: metadata },
        ),
      );
      return { capture, plan };
    });

    for (const { plan } of captures) {
      expect(dispatcher.sendPreparedReply("final", plan)).toBe(true);
    }
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["Edited first", "Edited second"]);
    expect(captures.map(({ capture }) => capture()?.text)).toEqual(delivered);
  });

  it.each([false, true])(
    "preserves prepared BTW text through prefixes and hook replacement (%s)",
    async (replaceText) => {
      const delivered: string[] = [];
      const dispatcher = createReplyDispatcher({
        responsePrefix: "[bot]",
        beforeDeliver: async (payload) => ({
          ...payload,
          text: replaceText ? "Replacement answer" : `${payload.text} Updated.`,
        }),
        deliver: async () => {
          throw new Error("expected prepared delivery");
        },
        deliverPrepared: async (plan) => {
          delivered.push(plan.parts.text);
        },
      });
      const [plan] = createOutboundPayloadPlan([{ text: "Answer", btw: { question: "Q" } }]);
      if (!plan) {
        throw new Error("expected a planned BTW reply");
      }
      const captureToken = {};
      const metadata = { sessionKey: "agent:test:session", idempotencyKey: "btw-reply" };
      setReplyPayloadMetadata(plan.payload, {
        finalDeliveryCapture: captureToken,
        sourceReplyTranscriptMirror: metadata,
      });
      const capture = captureDeliveredTranscriptMirror({ dispatcher, metadata, captureToken });

      expect(dispatcher.sendPreparedReply("final", plan)).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      const expected = replaceText
        ? "Replacement answer"
        : "[bot] BTW\nQuestion: Q\n\nAnswer Updated.";
      expect(delivered).toEqual([expected]);
      expect(capture()?.text).toBe(expected);
    },
  );

  it.each([
    {
      name: "unconfirmed send",
      result: { visibleReplySent: true, ambiguous: true },
      state: "unknown",
      count: "failedAfterSend",
      fallback: true,
    },
    {
      name: "channel transform",
      result: { visibleReplySent: false, suppression: { reason: "channel_transform" } },
      state: "suppressed",
      count: "deliveredNotVisible",
      fallback: true,
    },
    {
      name: "confirmed send",
      result: { visibleReplySent: true },
      state: "delivered",
      count: "delivered",
      fallback: true,
    },
    {
      name: "ordinary invisible result",
      result: { visibleReplySent: false },
      state: "delivered",
      count: "deliveredNotVisible",
      fallback: false,
    },
  ] as const)(
    "records callback settlement for $name before reopening",
    async ({ result, state, count, fallback }) => {
      const fixture = await makePendingFinalFixture();
      const deliver = vi.fn(async () => result);
      try {
        if (fallback) {
          attachReplyDispatchUndeliveredFallback(fixture.payload, { text: "fallback" });
        }
        const dispatcher = createReplyDispatcher({ deliver });
        dispatcher.sendFinalReply(fixture.payload);
        dispatcher.markComplete();
        const receipt = await dispatcher.waitForIdle();
        await closeOpenClawAgentDatabasesAsync(fixture.tmpDir);
        closeOpenClawAgentDatabasesForTest(fixture.tmpDir);
        expect(
          (loadSessionEntry(fixture) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
        ).toEqual([{ id: "delivery-1", state }]);
        expect(receipt?.counts.final[count]).toBe(1);
        expect(receipt?.anyVisibleDelivered).toBe(result.visibleReplySent);

        const replay = createReplyDispatcher({ deliver });
        replay.sendFinalReply(fixture.payload);
        replay.markComplete();
        await replay.waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        await closeOpenClawAgentDatabasesAsync(fixture.tmpDir);
        closeOpenClawAgentDatabasesForTest(fixture.tmpDir);
        await fs.rm(fixture.tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["raw", "prepared"] as const)(
    "delivers the attached %s fallback when the primary payload is cancelled",
    async (operation) => {
      const delivered: string[] = [];
      const plan = planReply({ text: "caption", mediaUrl: "/tmp/voice.ogg" });
      const primary = plan.payload;
      attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
      const outcome = captureReplyDispatchDeliveryOutcome(primary);
      const dispatcher = createReplyDispatcher({
        beforeDeliver: (payload) => (payload.mediaUrl ? null : payload),
        deliver: async (payload) => {
          delivered.push(`raw:${payload.text}`);
        },
        deliverPrepared: async (entry) => {
          delivered.push(`prepared:${entry.parts.text}`);
        },
      });

      expect(
        operation === "raw"
          ? dispatcher.sendFinalReply(primary)
          : dispatcher.sendPreparedReply("final", plan),
      ).toBe(true);
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();

      expect(delivered).toEqual([`${operation}:caption`]);
      expect(outcome.isTracked()).toBe(true);
      await expect(outcome.promise).resolves.toBe("delivered");
      expect(receipt?.counts.final.cancelled).toBe(0);
    },
  );

  it("does not resurrect fallback text after a channel transform veto", async () => {
    const delivered: ReplyPayload[] = [];
    const skipped: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const dispatcher = createReplyDispatcher({
      transformReplyPayload: (payload) => (payload.mediaUrl ? null : payload),
      onSkip: (_payload, info) => skipped.push(info.reason),
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });

    expect(dispatcher.sendFinalReply(primary)).toBe(false);
    expect(dispatcher.sendFinalReply({ text: "safe reply" })).toBe(true);
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(delivered).toEqual([{ text: "safe reply" }]);
    expect(skipped).toEqual(["channel_transform"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(receipt?.counts.final.cancelled).toBe(0);
  });

  it.each([
    { queueCustody: undefined, deferred: false },
    { queueCustody: "held", deferred: false },
    { queueCustody: "released", deferred: false },
    { queueCustody: undefined, deferred: true },
    { queueCustody: "held", deferred: true },
    { queueCustody: "released", deferred: true },
  ] as const)(
    "retries a proven pre-transport failure only without held queue custody ($queueCustody, deferred=$deferred)",
    async ({ queueCustody, deferred }) => {
      const delivered: string[] = [];
      const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
      attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          if (payload.mediaUrl) {
            const cause = Object.assign(new Error("connect failed"), {
              code: "ECONNREFUSED",
              syscall: "connect",
            });
            const error = Object.assign(new OutboundDeliveryError(cause.message, { cause }), {
              queueCustody,
            });
            if (deferred) {
              return { finalization: Promise.reject(error) };
            }
            throw error;
          }
          delivered.push(payload.text ?? "");
          return undefined;
        },
        propagateRetryableNoSendFailure: true,
      });

      dispatcher.sendFinalReply(primary);
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();

      expect(delivered).toEqual(queueCustody === "held" ? [] : ["caption"]);
      expect(receipt?.counts.final.failedBeforeSend).toBe(queueCustody === "held" ? 1 : 0);
      expect(receipt?.counts.final.failedAfterSend).toBe(0);
      expect(receipt?.anyVisibleDelivered).toBe(queueCustody !== "held");
    },
  );

  it("does not call a proven permanent rejection pending", async () => {
    const payload: ReplyPayload = { text: "rejected", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(payload, { text: "rejected" });
    const capture = captureReplyDispatchDeliveryOutcome(payload);
    const deliver = vi.fn(async () => {
      throw new PlatformMessageNotDispatchedError("rejected before dispatch", {
        cause: undefined,
        retryable: false,
      });
    });
    const dispatcher = createReplyDispatcher({ deliver });
    dispatcher.sendFinalReply(payload);
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledOnce();
    expect(receipt?.hasPendingDelivery).toBeUndefined();
    expect(capture.hasPendingDelivery()).toBe(false);
  });

  it("does not rerun dynamic prefix normalization after pre-side-effect preparation", async () => {
    const delivered: string[] = [];
    let model = "first";
    const dispatcher = createReplyDispatcher({
      responsePrefix: "[{model}]",
      responsePrefixContextProvider: () => ({ model }),
      transformReplyPayload: (payload) => payload,
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    const prepared = prepareReplyPayloadForDispatcher(dispatcher, "final", { text: "reply" });
    if (prepared.kind !== "deliver") {
      throw new Error("expected prepared reply delivery");
    }
    model = "second";

    dispatcher.sendFinalReply(prepared.payload);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["[first] reply"]);
  });

  it.each(["cancel", "throw"] as const)(
    "notifies cancellation when beforeDeliver exits with %s",
    async (outcome) => {
      const delivered: string[] = [];
      const cancelled: Array<{
        assistantMessageIndex?: number;
        kind: string;
        text: string;
      }> = [];
      const errors: Array<{
        assistantMessageIndex?: number;
        kind: string;
        message: string;
      }> = [];

      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
        onBeforeDeliverCancelled: (payload, info) => {
          cancelled.push({
            assistantMessageIndex: info.assistantMessageIndex,
            kind: info.kind,
            text: payload.text ?? "",
          });
        },
        onError: (err, info) => {
          errors.push({
            assistantMessageIndex: info.assistantMessageIndex,
            kind: info.kind,
            message: err instanceof Error ? err.message : String(err),
          });
        },
        beforeDeliver: async (payload) => {
          if (outcome === "throw") {
            throw new Error("pre-delivery failed");
          }
          return payload.text?.includes("blocked") ? null : payload;
        },
      });

      if (outcome === "throw") {
        dispatcher.sendBlockReply(
          setReplyPayloadMetadata({ text: "blocked block" }, { assistantMessageIndex: 9 }),
        );
      } else {
        dispatcher.sendFinalReply({ text: "blocked reply" });
        dispatcher.sendFinalReply({ text: "safe reply" });
      }
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();

      if (outcome === "throw") {
        expect(delivered).toEqual([]);
        expect(cancelled).toEqual([
          { assistantMessageIndex: 9, kind: "block", text: "blocked block" },
        ]);
        expect(errors).toEqual([
          { assistantMessageIndex: 9, kind: "block", message: "pre-delivery failed" },
        ]);
        expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 1, final: 0 });
        expect(receipt?.counts.block).toMatchObject({ cancelled: 0, failedBeforeSend: 1 });
      } else {
        expect(delivered).toEqual(["safe reply"]);
        expect(cancelled).toEqual([
          { assistantMessageIndex: undefined, kind: "final", text: "blocked reply" },
        ]);
        expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 2 });
        expect(receipt?.counts.final.cancelled).toBe(1);
      }
    },
  );

  it.each(["provider", "cancellation observer"] as const)(
    "records custody before waiting for the %s",
    async (stage) => {
      const fixture = await makePendingFinalFixture();
      const entered = createDeferred();
      const release = createDeferred();
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const suppressed = stage === "cancellation observer";
      try {
        const dispatcher = createReplyDispatcher({
          deliver: suppressed ? async () => {} : pause,
          beforeDeliver: suppressed ? () => null : undefined,
          onBeforeDeliverCancelled: suppressed ? pause : undefined,
        });

        dispatcher.sendFinalReply(fixture.payload);
        dispatcher.markComplete();
        await entered.promise;

        expect(
          (loadSessionEntry(fixture) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
        ).toEqual([{ id: "delivery-1", state: suppressed ? "suppressed" : "queued" }]);

        release.resolve();
        await dispatcher.waitForIdle();
        expect(
          (loadSessionEntry(fixture) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
        ).toEqual([{ id: "delivery-1", state: suppressed ? "suppressed" : "delivered" }]);
      } finally {
        release.resolve();
        await fs.rm(fixture.tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.each(
    [
      ...[false, true].map((admitDirect) => ({
        label: admitDirect ? "admitted direct no-send" : "proven pre-send failure",
        error: () =>
          Object.assign(new Error("connect failed"), { code: "ECONNREFUSED", syscall: "connect" }),
        expected: "prepared",
        failedBeforeSend: true,
        admitDirect,
      })),
      {
        label: "ambiguous provider failure",
        error: () => new Error("send outcome unknown"),
        expected: "unknown",
        failedBeforeSend: false,
        admitDirect: false,
      },
      {
        label: "queue-owned pre-send failure",
        error: () =>
          Object.assign(
            new OutboundDeliveryError("connect failed", {
              cause: Object.assign(new Error("connect failed"), {
                code: "ECONNREFUSED",
                syscall: "connect",
              }),
            }),
            { queueCustody: "held" },
          ),
        expected: "queued",
        failedBeforeSend: true,
        admitDirect: false,
      },
      {
        label: "queue-owned wrapped partial send",
        error: () =>
          createChannelPartialDeliveryError(
            Object.assign(
              new OutboundDeliveryError("remaining send failed", {
                cause: new Error("remaining send failed"),
                results: [{ channel: "matrix", messageId: "accepted-prefix" }],
              }),
              { queueCustody: "held" },
            ),
            { visibleReplySent: true, messageIds: ["accepted-prefix"] },
          ),
        expected: "queued",
        failedBeforeSend: false,
        admitDirect: false,
      },
    ].flatMap((entry) =>
      entry.admitDirect
        ? [{ ...entry, deferred: false }]
        : [
            { ...entry, deferred: false },
            { ...entry, deferred: true },
          ],
    ),
  )(
    "records $label before reporting the error (deferred=$deferred)",
    async ({ error, expected, failedBeforeSend, deferred, admitDirect }) => {
      const fixture = await makePendingFinalFixture();
      const failure = error();
      const onError = vi.fn();
      try {
        const deliver = vi.fn(async (payload: ReplyPayload) => {
          if (admitDirect) {
            await createDirectPendingFinalCustody(payload)?.onPlatformSendDispatch();
          }
          if (deferred) {
            return { finalization: Promise.reject(failure) };
          }
          throw failure;
        });
        const dispatcher = createReplyDispatcher({ deliver, onError });
        const capture = captureReplyDispatchDeliveryOutcome(fixture.payload);
        const pending = expected !== "prepared";
        if (pending) {
          attachReplyDispatchUndeliveredFallback(fixture.payload, { text: "duplicate fallback" });
        }
        dispatcher.sendFinalReply(fixture.payload);
        dispatcher.markComplete();
        const receipt = await dispatcher.waitForIdle();
        await expect(capture.promise).resolves.toBe(
          !failedBeforeSend
            ? "failed-deliver"
            : pending
              ? "recovery-owned"
              : "failed-before-deliver",
        );
        expect(capture.hasPendingDelivery()).toBe(pending);
        expect(receipt?.hasPendingDelivery).toBe(pending ? true : undefined);
        expect(deliver).toHaveBeenCalledTimes(1);

        if (deferred) {
          expect(onError).not.toHaveBeenCalled();
        } else {
          expect(onError.mock.calls[0]?.[0]).toBe(failure);
        }
        expect(receipt?.counts.final).toMatchObject({
          failedBeforeSend: failedBeforeSend ? 1 : 0,
          failedAfterSend: failedBeforeSend ? 0 : 1,
        });

        expect(
          (loadSessionEntry(fixture) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
        ).toEqual([{ id: "delivery-1", state: expected }]);
      } finally {
        await fs.rm(fixture.tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.each(
    (["raw", "prepared"] as const).flatMap((operation) => [
      { operation, replaced: false },
      { operation, replaced: true },
    ]),
  )(
    "suppresses a $operation call after its owner is terminal or replaced ($replaced)",
    async ({ operation, replaced }) => {
      const fixture = await makePendingFinalFixture();
      const deliver = vi.fn(async () => {});
      const options = {
        beforeDeliver: async () => ({ text: "rewritten final" }),
        deliver,
        deliverPrepared: async () => deliver(),
      };
      try {
        if (replaced) {
          const current = loadSessionEntry(fixture) as InternalSessionEntry;
          await replaceSessionEntry(fixture, {
            ...current,
            pendingFinalDelivery: {
              ...current.pendingFinalDelivery!,
              intentId: "replacement-intent",
            },
          });
        } else {
          const first = createReplyDispatcher(options);
          expect(sendFinal(first, operation, fixture.payload)).toBe(true);
          first.markComplete();
          await first.waitForIdle();
        }

        const second = createReplyDispatcher(options);
        expect(sendFinal(second, operation, fixture.payload)).toBe(true);
        second.markComplete();
        const receipt = await second.waitForIdle();

        expect(deliver).toHaveBeenCalledTimes(replaced ? 0 : 1);
        expect(receipt?.counts.final.cancelled).toBe(1);
      } finally {
        await fs.rm(fixture.tmpDir, { recursive: true, force: true });
      }
    },
  );
});
