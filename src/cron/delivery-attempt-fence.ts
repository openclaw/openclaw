/** Host-held occurrence authority; never serialized into a tool or transport request. */
export type CronCompletionDeliveryFence = {
  beforeAttempt: () => Promise<void>;
  assertCurrent: () => void;
  /** Diagnostics settle through the captured receipt owner, never delivery authority. */
  recordWithheld?: (outcome: {
    runId: string;
    sessionKey?: string;
    error: string;
  }) => Promise<void>;
};
