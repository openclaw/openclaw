import type { GatewayEventFrame } from "../../api/gateway.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionRowEventListener,
} from "./session-capability.ts";
import type { SessionChangedRowResult } from "./session-row-reconcile.ts";

export type SessionEventDelivery<Registration extends { snapshot: unknown }> = {
  results: Map<Registration, SessionChangedRowResult>;
  deliver: (event: GatewayEventFrame, acceptsGeneration?: () => boolean) => void;
};

export function createSessionEventDelivery<
  Registration extends { snapshot: unknown; onEvent?: SessionRowEventListener },
>(
  entries: Iterable<Registration>,
  connection: SessionConnectionOwner,
  isAttached: (entry: Registration) => boolean,
  isCurrent: (entry: Registration) => boolean,
) {
  return (scope: SessionConnectionScope | null): SessionEventDelivery<Registration> => {
    const registrations = new Set([...entries].filter(isCurrent));
    const results: SessionEventDelivery<Registration>["results"] = new Map();
    return {
      results,
      deliver(event, acceptsGeneration) {
        for (const entry of registrations) {
          if (!scope || !connection.isCurrent(scope)) {
            return;
          }
          if (!entry.onEvent || !isAttached(entry)) {
            continue;
          }
          try {
            const recorded = results.get(entry);
            const result: Parameters<SessionRowEventListener>[1] =
              acceptsGeneration?.() === false
                ? { applied: false, generationRejected: true }
                : recorded && (isCurrent(entry) || recorded.deletedKey)
                  ? recorded
                  : { applied: false };
            // Rejected generations still wake outboxes; they cannot mutate a pane's transcript.
            entry.onEvent(event, result);
          } catch (error) {
            console.error("[sessions] event observer error:", error);
          }
        }
      },
    };
  };
}
