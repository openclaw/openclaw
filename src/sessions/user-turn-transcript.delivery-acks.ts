import type { PersistedUserTurnMessage } from "./user-turn-transcript.types.js";

/**
 * Session-delivery ack ids carried on a user turn. A replacement set, once given,
 * fully replaces the message's ids before persistence (an empty set removes them).
 * The recorder reports when persistence has started; replacement is refused from then on.
 */
export function createSessionDeliveryAckReplacement(
  initial: PersistedUserTurnMessage | undefined,
  persistenceStarted: () => unknown,
) {
  const ids = new Set<string>();
  let replaced = false;
  const add = (deliveryIds: readonly unknown[]) => {
    for (const deliveryId of deliveryIds) {
      const normalized = typeof deliveryId === "string" ? deliveryId.trim() : "";
      if (normalized) {
        ids.add(normalized);
      }
    }
  };
  const initialIds = initial?.["__openclaw"]?.sessionDeliveryAckIds;
  if (Array.isArray(initialIds)) {
    replaced = true;
    add(initialIds);
  }
  return {
    replace(deliveryIds: readonly string[]): boolean {
      if (persistenceStarted()) {
        return false;
      }
      replaced = true;
      ids.clear();
      add(deliveryIds);
      return true;
    },
    apply(candidate: PersistedUserTurnMessage | undefined): PersistedUserTurnMessage | undefined {
      if (!candidate || !replaced) {
        return candidate;
      }
      const metadata = { ...candidate["__openclaw"] };
      delete metadata.sessionDeliveryAckIds;
      return {
        ...candidate,
        __openclaw: {
          ...metadata,
          ...(ids.size > 0 ? { sessionDeliveryAckIds: [...ids] } : {}),
        },
      };
    },
  };
}
