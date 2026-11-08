import type { SessionEntriesCurrentCheck } from "../../config/sessions/session-entry-current.types.js";

/** A storage predicate supplies worker facts without replacing its caller's lifetime fences. */
export type GatewayToolCallerReceiptAdmission = {
  prepare(): Promise<{
    current: SessionEntriesCurrentCheck;
    isCurrent(): boolean;
  }>;
};
