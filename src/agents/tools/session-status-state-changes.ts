import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { SessionStateReadOperations } from "../../sessions/session-state-events.read.worker-contract.js";

function compactSessionStateEventPayload(
  payload: Record<string, unknown> | undefined,
): { outcome?: "error" | "timeout" | "cancelled"; channel?: string; turns?: number } | undefined {
  if (!payload) {
    return undefined;
  }
  const outcome =
    payload.outcome === "error" || payload.outcome === "timeout" || payload.outcome === "cancelled"
      ? payload.outcome
      : undefined;
  const channel = readStringValue(payload.channel);
  const turns = asPositiveSafeInteger(payload.turns);
  return outcome || channel || turns !== undefined
    ? {
        ...(outcome ? { outcome } : {}),
        ...(channel ? { channel } : {}),
        ...(turns !== undefined ? { turns } : {}),
      }
    : undefined;
}

export function compactSessionStateChanges(
  stateChanges: SessionStateReadOperations["sessionState.events"]["output"]["page"],
) {
  return {
    ...stateChanges,
    events: stateChanges.events.map((event) => {
      const payload = compactSessionStateEventPayload(event.payload);
      return {
        sequence: event.sequence,
        kind: event.kind,
        actorType: event.actorType,
        occurredAt: event.occurredAt,
        summary: event.summary,
        ...(event.actorId ? { actorId: event.actorId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        ...(payload ? { payload } : {}),
      };
    }),
  };
}

export function formatSessionStateChanges(details: {
  stateVersion: number;
  stateChanges: ReturnType<typeof compactSessionStateChanges>;
}): string {
  return `Session state changes:
\`\`\`json
${JSON.stringify(details, null, 2)}
\`\`\``;
}
