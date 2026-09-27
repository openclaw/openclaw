import type { ChannelProgressDraftCompositorSnapshot } from "./progress-draft-compositor.types.js";

/** Positive platform evidence plus data-only presentation state, never a transport callback. */
type ProgressContinuationReceipt = {
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

export type ProgressContinuationCapability = {
  adopt: (this: void, receipt: ProgressContinuationReceipt) => Promise<boolean>;
  close: () => void;
};
