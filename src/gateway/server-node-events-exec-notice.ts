import {
  enqueueSessionEventForHost,
  type SessionEventTarget,
} from "../auto-reply/reply/session-event-handoff.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
} from "../infra/system-events.js";
import type { NodeEventContext } from "./server-node-events-types.js";

/** Transfer the authorized exec notice and its captured route to one ordinary turn. */
export function enqueueNodeExecNotice(params: {
  sessionKey: string;
  agentId: string;
  authorization: ReturnType<NodeEventContext["authorizeNodeSystemRunEvent"]>;
  runId: string;
  text: string;
  expectedTarget: SessionEventTarget;
  assertAcceptanceCurrent: () => void;
}) {
  const { sessionKey, agentId, runId, text, expectedTarget, assertAcceptanceCurrent } = params;
  // The registry owns this snapshot; the terminal payload never supplies a route.
  // Calls without a host-bound route retain the captured session fallback.
  const deliveryContext =
    (typeof params.authorization === "object"
      ? params.authorization.invocationDeliveryContext
      : undefined) ?? expectedTarget.deliveryContext;
  assertAcceptanceCurrent();
  const eventOptions = withSystemEventOwner(
    { sessionKey, contextKey: runId ? `exec:${runId}` : "exec", deliveryContext },
    agentId,
  );
  const occurrence = enqueueSystemEventEntry(text, eventOptions);
  if (!occurrence) {
    return undefined;
  }
  try {
    return enqueueSessionEventForHost(text, {
      agentId,
      sessionKey,
      source: "node",
      contextKey: eventOptions.contextKey,
      deliveryContext,
      expectedTarget,
      occurrences: [occurrence],
      assertAcceptanceCurrent,
    });
  } catch (error) {
    consumeSelectedSystemEventEntries(eventOptions.sessionKey, [occurrence]);
    throw error;
  }
}
