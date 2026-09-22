import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionRowEventListener,
} from "./session-capability.ts";
import type { SessionChangedRowResult } from "./session-row-reconcile.ts";

export type SessionEventDelivery<Registration extends { snapshot: unknown }> = {
  captures: (entry: Registration) => boolean;
  results: Map<
    Registration,
    { snapshot: Registration["snapshot"]; result: SessionChangedRowResult }
  >;
  deliver: (event: GatewayEventFrame, acceptsGeneration?: () => boolean) => void;
};

export function createSessionEventDelivery<
  Registration extends { snapshot: unknown; onEvent?: SessionRowEventListener },
>(
  entries: Iterable<Registration>,
  connection: SessionConnectionOwner,
  isAttached: (entry: Registration) => boolean,
  isCurrent: (entry: Registration) => boolean,
  hasNewerFacts: (row: GatewaySessionRow, revision: number) => boolean,
) {
  return (
    scope: SessionConnectionScope | null,
    revision: number,
  ): SessionEventDelivery<Registration> => {
    const registrations = new Set([...entries].filter(isCurrent));
    const results: SessionEventDelivery<Registration>["results"] = new Map();
    return {
      captures: (entry) => registrations.has(entry),
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
                : recorded &&
                    (isCurrent(entry) || recorded.result.deletedKey) &&
                    entry.snapshot === recorded.snapshot &&
                    (!recorded.result.admittedRow ||
                      !hasNewerFacts(recorded.result.admittedRow, revision))
                  ? recorded.result
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
