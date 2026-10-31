import type { DeliveryContext } from "../../utils/delivery-context.types.js";

export type PendingFinalDeliveryState = {
  createdAt: number;
  context?: DeliveryContext;
  intentId?: string;
  /** Original admitted source; survives claim cleanup before the queued final settles. */
  sourceRunId?: string;
  deliveries?: Array<{
    id: string;
    state: "prepared" | "queued" | "delivered" | "suppressed" | "unknown";
    /** Same-route identified evidence for the complete logical member, not just its last send. */
    receipt?: { platformMessageId: string; resultCount: number };
  }>;
} & ({ kind: "replayable"; text: string } | { kind: "transport-only" });

/**
 * Owed user-visible notice that a final's delivery outcome stayed unknown.
 * Settled unknown custody records the debt here; the next same-route turn
 * sends it once, so an ambiguous loss never ends silently.
 */
export type PendingDeliveryNoticeState = {
  createdAt: number;
  context: DeliveryContext;
  intentId: string;
  state: "owed" | "unresolved" | "acknowledged";
};
