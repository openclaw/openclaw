/** Host-held occurrence authority; never serialized into a tool or transport request. */
export type CronCompletionDeliveryFence = {
  /** Scheduled occurrence this run delivers; durable delivery intents key on it. */
  occurrenceAtMs: number;
  /** The occurrence's admitted intent, kept current as this run admits or releases it. */
  admittedIntentId?: string;
  /** Records a possible delivery; an announcement's intent is admitted for the occurrence. */
  beforeAttempt: (admission?: { intentId: string }) => Promise<void>;
  /** Withdraws the admission after an attempt left its intent unsent and out of queue custody. */
  releaseAdmission?: (intentId: string) => Promise<void>;
  assertCurrent: () => void;
};
