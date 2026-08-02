// Defines durable evidence and owner-recovery settings.

export type DurableRuntimeMode = "off" | "observe" | "authority";

export type DurableRuntimeConfig = {
  /** Durable behavior mode. `authority` requires durable intake before acceptance. */
  mode?: DurableRuntimeMode;
  worker?: {
    /** Recovery and execution worker polling interval. Default: 1000. */
    pollIntervalMs?: number;
    /** Lease duration for worker-owned claims. Default: 300000. */
    claimTtlMs?: number;
  };
};
