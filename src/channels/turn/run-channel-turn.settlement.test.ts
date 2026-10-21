import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import * as deliveryCompletion from "../../infra/outbound/delivery-completion.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createDispatcherBackedDispatch,
} from "./run-channel-turn.delivery.test-helpers.js";

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
  const deliveries = (state: "prepared" | "unknown" | "delivered") => [
    { id: completion.deliveryId, state },
    ...(sibling ? [{ id: "delivery-2", state: "prepared" as const }] : []),
  ];
  await replaceSessionEntry(scope, {
    sessionId: completion.sessionId,
    updatedAt: 1,
    pendingFinalDelivery: {
      kind: "replayable",
      text: "the final answer",
      createdAt: 1,
      intentId: completion.intentId,
      context: noticeContext,
      deliveries: deliveries("prepared"),
    },
  });
  const readEntry = () => readSessionEntryReadOnlyInWorker(scope);
  const expectedPending = sibling ? deliveries("delivered") : undefined;
  const observerError = new Error("post-delivery observer failed");
  const onDelivered = vi.fn(async () => {
    const entry = await readEntry();
    expect(entry?.pendingFinalDelivery?.deliveries).toEqual(expectedPending);
    if (!sibling) {
      expect(entry?.pendingFinalDelivery).toBeUndefined();
    }
    if (observerThrows) {
      throw observerError;
    }
  });
  let admittedEntry: Awaited<ReturnType<typeof readEntry>>;
  const deliver = vi.fn(async () => {
    admittedEntry = await readEntry();
    expect(admittedEntry?.pendingFinalDelivery?.deliveries).toEqual(deliveries("unknown"));
    expect(admittedEntry?.pendingDeliveryNotice).toMatchObject({
      intentId: completion.intentId,
      state: "owed",
      context: noticeContext,
    });
    return { visibleReplySent: true, messageIds: ["message-1"] };
  });
  const onError = vi.fn();
  const settlement = vi.spyOn(deliveryCompletion, "settlePendingFinalDelivery");
  const assertDeliveredOnce = () => {
    expect(deliver).toHaveBeenCalledOnce();
    expect(onDelivered).toHaveBeenCalledOnce();
  };
  const dispatch = createDispatcherBackedDispatch(
    () => {},
    () =>
      setReplyPayloadMetadata(
        { text: "the final answer" },
        {
          pendingFinalDeliveryCompletion: { ...completion },
          pendingFinalDeliveryCleanup: { preserveActivity: true },
        },
      ),
  );
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
  assertDeliveredOnce();
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
  assertDeliveredOnce();
  expect((await readEntry())?.pendingFinalDelivery?.deliveries).toEqual(expectedPending);
  expect((await readEntry())?.updatedAt).toBe(1);

  // Replaying a crash-ambiguous attempt must not restore it to sendable custody.
  const admitted = expectDefined(admittedEntry, "expected persisted pre-send custody");
  await replaceSessionEntry(scope, admitted);
  await run();
  await run();
  assertDeliveredOnce();
  const afterReplay = await readEntry();
  expect(afterReplay?.pendingFinalDelivery).toEqual(admitted.pendingFinalDelivery);
  expect(afterReplay?.pendingDeliveryNotice).toEqual(admitted.pendingDeliveryNotice);
});
