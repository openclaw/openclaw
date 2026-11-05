export type AckDeliveryOptions = {
  /** Caller holds a GC-visible recovery lease until its active adapter settles. */
  retainSpoolArtifacts?: boolean;
  /** An intentionally suppressed pre-send batch must not become a success receipt. */
  suppressCompletionReceipt?: boolean;
  /** Prevent an older provider attempt from settling a replacement owner. */
  expectedPlatformSendAttemptId?: string | null;
};

export type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };
