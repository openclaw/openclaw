/** Host-held occurrence authority; never serialized into a tool or transport request. */
export type CronCompletionDeliveryFence = {
  beforeAttempt: () => Promise<void>;
  assertCurrent: () => void;
};
