import type { ReplyPayload } from "../reply-payload.js";

/** Coalesce repeated item snapshots and flush commentary ahead of the final reply. */
export function createDispatchCommentaryProgress(params: {
  shouldDeliverCommentary: () => Promise<boolean>;
  shouldSuppressDelivery: () => Promise<boolean>;
  isAborted: () => boolean;
  isFinalDeliveryStarted: () => boolean;
  assertCurrent: () => void;
  send: (payload: ReplyPayload) => Promise<unknown> | void;
}) {
  let pendingCommentaryProgress: { itemId?: string; text: string } | null = null;
  const flushedCommentaryItems = new Set<string>();
  const deliverCommentaryProgressMessage = async (text: string) => {
    if (!(await params.shouldDeliverCommentary()) || (await params.shouldSuppressDelivery())) {
      return;
    }
    if (params.isAborted() || params.isFinalDeliveryStarted()) {
      return;
    }
    params.assertCurrent();
    await params.send({ text: `💬 ${text}` });
  };
  const flushPendingCommentaryProgress = async () => {
    const pending = pendingCommentaryProgress;
    pendingCommentaryProgress = null;
    const text = pending?.text.trim();
    if (!text) {
      return;
    }
    if (pending?.itemId) {
      flushedCommentaryItems.add(pending.itemId);
    }
    await deliverCommentaryProgressMessage(text);
  };
  const noteCommentaryProgress = async (payload: { itemId?: string; progressText?: string }) => {
    const itemId = payload.itemId?.trim() || undefined;
    if (params.isFinalDeliveryStarted() || (itemId && flushedCommentaryItems.has(itemId))) {
      return;
    }
    const text = payload.progressText ?? "";
    const updatesBufferedItem =
      pendingCommentaryProgress !== null &&
      ((pendingCommentaryProgress.itemId !== undefined &&
        pendingCommentaryProgress.itemId === itemId) ||
        pendingCommentaryProgress.text.trim() === text.trim());
    if (!text.trim()) {
      // Empty commentary retracts a buffered item before it has been sent.
      if (updatesBufferedItem) {
        pendingCommentaryProgress = null;
      }
      return;
    }
    if (pendingCommentaryProgress && !updatesBufferedItem) {
      await flushPendingCommentaryProgress();
    }
    pendingCommentaryProgress = { itemId, text };
  };
  return { flushPendingCommentaryProgress, noteCommentaryProgress };
}
