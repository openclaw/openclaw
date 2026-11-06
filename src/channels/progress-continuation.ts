import type { ChannelProgressDraftCompositorSnapshot } from "./progress-draft-compositor.types.js";
import type { ItemProgressPayload } from "./progress-draft-events.js";

/** The 2026.9.8 receipt handoff argument; the host no longer offers that capability. */
export type ProgressContinuationReceipt = {
  channel: string;
  accountId?: string;
  to: string;
  threadId?: string | number;
  messageId: string;
  text: string;
  snapshot: ChannelProgressDraftCompositorSnapshot;
};

export type ProgressContinuationState = {
  operationId: string;
};

/**
 * A confirmed progress draft the channel keeps after its turn ends. The channel
 * owns rendering, throttling and deletion; the adopting owner only pushes
 * prepared items and retires the draft once.
 */
export type ProgressContinuationDraft = {
  push: (item: ItemProgressPayload) => void;
  retire: () => void;
};

export type ProgressContinuationCapability = {
  adopt: (this: void, draft: ProgressContinuationDraft) => boolean;
  close: () => void;
};
