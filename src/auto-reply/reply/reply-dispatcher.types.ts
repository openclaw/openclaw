import type { ReplyPayload } from "../types.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  /**
   * Enqueue a block reply for delivery.
   *
   * Returns `false` when the payload is dropped (empty/silent).
   * Otherwise returns a `Promise<true>` that resolves when the queued delivery
   * (and all preceding deliveries) complete.  Callers on the same-channel path
   * should `await` this to guarantee the block text reaches the user before
   * tool execution continues.
   *
   * Because a fulfilled `Promise` is truthy, existing boolean-style checks
   * (`if (delivered)`) remain correct without changes.
   */
  sendBlockReply: (payload: ReplyPayload) => false | Promise<true>;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
};
