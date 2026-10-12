import type { SqliteDatabaseAdmissionKey } from "./sqlite-database-admission.js";

export const emptyOutboundDeliveryQueueAdmission: SqliteDatabaseAdmissionKey<true | undefined> = {
  name: "state.empty-outbound-delivery-queue",
  read: (value) => (value === true ? true : undefined),
};
