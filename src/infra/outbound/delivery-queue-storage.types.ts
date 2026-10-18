import type { DeliveryQueueEntryState } from "../delivery-queue-sqlite.types.js";

export type StableDeliveryPreparation = DeliveryQueueEntryState & {
  preparationState: "claimed" | "modifiers_started" | "prepared";
  preparationOwnerId?: string;
  preparationLeaseExpiresAt?: number;
};

export type OutboundDeliveryStorageEntry = {
  queueName: string;
  entry: DeliveryQueueEntryState;
};

export type OutboundDeliverySnapshot = {
  queueName: string;
  entryJson: string;
};
