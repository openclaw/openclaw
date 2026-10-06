import type { ItemProgressPayload } from "./progress-draft-events.js";

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
