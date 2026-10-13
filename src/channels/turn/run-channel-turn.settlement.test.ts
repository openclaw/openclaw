import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import * as deliveryCompletion from "../../infra/outbound/delivery-completion.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import { createCtx } from "./run-channel-turn.delivery.test-helpers.js";
import type { AssembledChannelTurn } from "./types.js";

describe("channel turn terminal settlement", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-channel-settlement-");

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { label: "successful observer", observerThrows: false, sibling: false },
    { label: "throwing observer", observerThrows: true, sibling: false },
    { label: "throwing observer with a pending sibling", observerThrows: true, sibling: true },
  ])("commits delivery once before a $label", async ({ observerThrows, sibling }) => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:telegram:direct:chat-1";
    const scope = { sessionKey, storePath };
    const completion = {
      deliveryId: "delivery-1",
      intentId: "intent-1",
      sessionId: "session-1",
      ...scope,
    };
    const noticeContext = { channel: "telegram", to: "chat-1", accountId: "default" };
    await replaceSessionEntry(scope, {
      sessionId: completion.sessionId,
      updatedAt: 1,
      pendingFinalDelivery: {
        kind: "replayable",
        text: "the final answer",
        createdAt: 1,
        intentId: completion.intentId,
        context: noticeContext,
        deliveries: [
          { id: completion.deliveryId, state: "prepared" },
          ...(sibling ? [{ id: "delivery-2", state: "prepared" as const }] : []),
        ],
      },
    });
    const readEntry = () => readSessionEntryReadOnlyInWorker(scope);
    const expectedPending = sibling
      ? [
          { id: completion.deliveryId, state: "delivered" },
          { id: "delivery-2", state: "prepared" },
        ]
      : undefined;
    const observerError = new Error("post-delivery observer failed");
    const onDelivered = vi.fn<NonNullable<AssembledChannelTurn["delivery"]["onDelivered"]>>(
      async () => {
        const entry = await readEntry();
        expect(entry?.pendingFinalDelivery?.deliveries).toEqual(expectedPending);
        if (!sibling) {
          expect(entry?.pendingFinalDelivery).toBeUndefined();
        }
        if (observerThrows) {
          throw observerError;
        }
      },
    );
    let admittedEntry: Awaited<ReturnType<typeof readEntry>>;
    const deliver = vi.fn(async () => {
      admittedEntry = await readEntry();
      expect(admittedEntry?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "unknown" },
        ...(sibling ? [{ id: "delivery-2", state: "prepared" }] : []),
      ]);
      expect(admittedEntry?.pendingDeliveryNotice).toMatchObject({
        intentId: completion.intentId,
        state: "owed",
        context: noticeContext,
      });
      return { visibleReplySent: true, messageIds: ["message-1"] };
    });
    const onError = vi.fn();
    const settlement = vi.spyOn(deliveryCompletion, "settlePendingFinalDelivery");
    const dispatch: DispatchReplyWithBufferedBlockDispatcher = async (params) => {
      const dispatcher = createReplyDispatcher(params.dispatcherOptions);
      dispatcher.sendFinalReply(
        setReplyPayloadMetadata(
          { text: "the final answer" },
          {
            pendingFinalDeliveryCompletion: { ...completion },
            pendingFinalDeliveryCleanup: { preserveActivity: true },
          },
        ),
      );
      dispatcher.markComplete();
      const settledReceipt = (await dispatcher.waitForIdle()) || undefined;
      return { queuedFinal: true, counts: dispatcher.getQueuedCounts(), settledReceipt };
    };
    const run = () =>
      dispatchAssembledChannelTurn({
        cfg: { session: { store: storePath } },
        agentId: "main",
        storePath,
        channel: "telegram",
        accountId: "default",
        routeSessionKey: sessionKey,
        ctxPayload: createCtx({
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        }),
        recordInboundSession: async () => undefined,
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        delivery: { deliver, onDelivered, onError },
      });

    const first = await run();
    expect(first).toMatchObject({
      dispatched: true,
      dispatchResult: {
        settledReceipt: {
          anyVisibleDelivered: true,
          counts: { final: observerThrows ? { failedAfterSend: 1 } : { delivered: 1 } },
        },
      },
    });
    expect(deliver).toHaveBeenCalledOnce();
    expect(onDelivered).toHaveBeenCalledOnce();
    expect(settlement.mock.calls.some(([, state]) => state === "queued")).toBe(false);
    expect((await readEntry())?.pendingFinalDelivery?.deliveries).toEqual(expectedPending);
    if (observerThrows) {
      expect(onError).toHaveBeenCalledExactlyOnceWith(observerError, { kind: "final" });
      expect(observerError).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
    } else {
      expect(onError).not.toHaveBeenCalled();
    }
    expect(settlement.mock.calls.filter(([, state]) => state === "delivered")).toEqual([
      [
        { kind: "pending-final", ...completion },
        "delivered",
        undefined,
        { preserveActivity: true, clearAfterSettled: { recoveryRunId: undefined } },
      ],
    ]);

    // A fresh payload identity consults durable custody rather than the retained receipt.
    await run();
    expect(deliver).toHaveBeenCalledOnce();
    expect(onDelivered).toHaveBeenCalledOnce();
    expect((await readEntry())?.pendingFinalDelivery?.deliveries).toEqual(expectedPending);
    expect((await readEntry())?.updatedAt).toBe(1);

    // Replaying a crash-ambiguous attempt must not restore it to sendable custody.
    if (!admittedEntry) {
      throw new Error("expected persisted pre-send custody");
    }
    await replaceSessionEntry(scope, admittedEntry);
    await run();
    await run();
    expect(deliver).toHaveBeenCalledOnce();
    expect(onDelivered).toHaveBeenCalledOnce();
    const afterReplay = await readEntry();
    expect(afterReplay?.pendingFinalDelivery).toEqual(admittedEntry.pendingFinalDelivery);
    expect(afterReplay?.pendingDeliveryNotice).toEqual(admittedEntry.pendingDeliveryNotice);
  });
});
