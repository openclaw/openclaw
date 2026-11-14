import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { createPendingFinalFixture } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createDispatcherBackedDispatch,
  expectDispatched,
} from "./run-channel-turn.delivery.test-helpers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-channel-settlement-");

it.each([
  { label: "successful observer", observerThrows: false, sibling: false },
  { label: "throwing observer", observerThrows: true, sibling: false },
  { label: "throwing observer with a pending sibling", observerThrows: true, sibling: true },
])("commits delivery once before a $label", async ({ observerThrows, sibling }) => {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const sessionKey = "agent:main:telegram:direct:chat-1";
  const scope = { sessionKey, storePath };
  const noticeContext = { channel: "telegram", to: "chat-1", accountId: "default" };
  const { completion, entry } = createPendingFinalFixture(storePath, "delivery-1", sessionKey, {
    text: "the final answer",
    context: noticeContext,
  });
  if (sibling) {
    entry.pendingFinalDelivery.deliveries.push({ id: "delivery-2", state: "prepared" });
  }
  const deliveries = (state: "prepared" | "unknown" | "delivered") => [
    { id: completion.deliveryId, state },
    ...(sibling ? [{ id: "delivery-2", state: "prepared" as const }] : []),
  ];
  await replaceSessionEntry(scope, entry);
  const readEntry = () => readSessionEntryReadOnlyInWorker(scope);
  const expectedPending = sibling
    ? { ...entry.pendingFinalDelivery, deliveries: deliveries("delivered") }
    : undefined;
  const observerError = new Error("post-delivery observer failed");
  const onDelivered = vi.fn(async () => {
    expect((await readEntry())?.pendingFinalDelivery).toEqual(expectedPending);
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
  const once = () => [deliver, onDelivered].forEach((fn) => expect(fn).toHaveBeenCalledOnce());
  const createMetadata = () => ({
    pendingFinalDeliveryCompletion: { ...completion },
    pendingFinalDeliveryCleanup: { preserveActivity: true },
  });
  const dispatch = createDispatcherBackedDispatch(
    () => {},
    () => setReplyPayloadMetadata({ text: "the final answer" }, createMetadata()),
  );
  const run = () =>
    dispatchAssembledChannelTurn({
      cfg: { session: { store: storePath } },
      agentId: "main",
      storePath,
      channel: "telegram",
      accountId: "default",
      routeSessionKey: sessionKey,
      ctxPayload: createCtx({ SessionKey: sessionKey, Provider: "telegram", Surface: "telegram" }),
      recordInboundSession: async () => undefined,
      dispatchReplyWithBufferedBlockDispatcher: dispatch,
      delivery: { deliver, onDelivered, onError },
    });
  const first = await run();
  expectDispatched(first);
  expect(first.dispatchResult.settledReceipt).toMatchObject({
    anyVisibleDelivered: true,
    counts: { final: observerThrows ? { failedAfterSend: 1 } : { delivered: 1 } },
  });
  once();
  expect((await readEntry())?.pendingFinalDelivery).toEqual(expectedPending);
  expect(onError.mock.calls).toEqual(observerThrows ? [[observerError, { kind: "final" }]] : []);
  if (observerThrows) {
    expect(observerError).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
  }
  // A fresh payload identity consults durable custody rather than the retained receipt.
  await run();
  once();
  expect((await readEntry())?.pendingFinalDelivery).toEqual(expectedPending);
  expect((await readEntry())?.updatedAt).toBe(1);

  // Replaying a crash-ambiguous attempt must not restore it to sendable custody.
  const admitted = expectDefined(admittedEntry, "expected persisted pre-send custody");
  await replaceSessionEntry(scope, admitted);
  await run();
  await run();
  once();
  const afterReplay = await readEntry();
  expect(afterReplay?.pendingFinalDelivery).toEqual(admitted.pendingFinalDelivery);
  expect(afterReplay?.pendingDeliveryNotice).toEqual(admitted.pendingDeliveryNotice);
});
