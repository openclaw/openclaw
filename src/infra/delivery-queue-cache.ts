import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { SqliteDatabaseAdmissionKey } from "./sqlite-database-admission.js";

const enqueued = resolveGlobalSingleton(
  Symbol.for("openclaw.outboundDeliveryEnqueued"),
  () => new Set<(stateDir: string) => void>(),
);
export const onOutboundDeliveryEnqueued = (listener: (stateDir: string) => void) =>
  registerListener(enqueued, listener);
export const notifyOutboundDeliveryEnqueued = (stateDir: string) =>
  notifyListeners(enqueued, stateDir);

export const emptyOutboundDeliveryQueueAdmission: SqliteDatabaseAdmissionKey<true | undefined> = {
  name: "state.empty-outbound-delivery-queue",
  read: (value) => (value === true ? true : undefined),
};
