import type { SqliteDatabaseAdmissionKey } from "./sqlite-database-admission.js";

export const boundWebPushSubscriptionsAdmission: SqliteDatabaseAdmissionKey<boolean> = {
  name: "state.web-push-bound-subscriptions",
  read: (value) => (typeof value === "boolean" ? value : undefined),
};
