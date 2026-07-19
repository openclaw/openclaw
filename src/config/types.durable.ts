// Defines durable execution, recovery-worker, and evidence-retention settings.

export type DurableRuntimeMode = "off" | "observe" | "authority";

export type DurableRuntimeConfig = {
  /** Durable behavior mode. `authority` requires durable intake before acceptance. */
  mode?: DurableRuntimeMode;
  worker?: {
    /** Recovery and execution worker polling interval. Default: 1000. */
    pollIntervalMs?: number;
    /** Lease duration for worker-owned claims. Default: 300000. */
    claimTtlMs?: number;
    /** Maximum concurrency for each registered operation-scoped executor. Default: 1. */
    maxConcurrency?: number;
  };
  input?: {
    /** Maximum input preview characters retained in evidence. Default: 600. */
    previewChars?: number;
    /** Input text retention policy. Default: preview. */
    text?: "metadata" | "preview" | "full";
    /** Maximum characters retained when `text` is `full`. Default: 16384. */
    fullMaxChars?: number;
  };
};
