// Handles the `location.update` node event: a sender-identified fix from a
// paired node (iOS significant-location monitor).
//
// Coordinates are untrusted input. They are validated once here against the
// closed payload schema and then handed, typed, to exactly one
// plugin-registered consumer read from the *active* plugin registry — so a
// plugin reload or rollback retires its subscription with the registry
// generation instead of leaving a stale handler attached.
//
// The raw payload is never logged, broadcast, or persisted: an unsubscribed
// event costs nothing beyond validation, and a subscribed one is evaluated
// against user-armed intents and then discarded.
import { Value } from "typebox/value";
import {
  NodeLocationUpdatePayloadSchema,
  type NodeLocationUpdatePayload,
} from "../../packages/gateway-protocol/src/schema/nodes.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../plugins/runtime-state.js";
import {
  isNodeEventConnectionCurrent,
  pairingChangedResult,
  parseNodeEventPayload,
} from "./server-node-event-source.js";
import type {
  NodeEvent,
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";

export async function handleNodeLocationEvent(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
): Promise<NodeEventHandleResult> {
  const locationPayload = parseNodeEventPayload(evt.payloadJSON);
  if (!Value.Check(NodeLocationUpdatePayloadSchema, locationPayload)) {
    return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
  }
  const consumer = getActivePluginGatewayNodePolicyRegistry()?.nodeEventConsumers.find((entry) =>
    entry.subscription.events.includes(evt.event),
  );
  if (!consumer) {
    return { ok: true, event: evt.event, handled: false, reason: "no_consumer" };
  }
  if (!(await isNodeEventConnectionCurrent(opts))) {
    return pairingChangedResult(evt.event);
  }
  // Consumers may be synchronous (void) or asynchronous (Promise). A
  // declared void return is not evidence of synchrony: an `async` handler
  // is assignable to it, and discarding its promise would leak rejections
  // to the process-level handler, which exits the Gateway. Observe both
  // shapes so a failing consumer stays isolated and logged.
  const observeConsumerOutcome = (outcome: void | Promise<void>) => {
    if (outcome instanceof Promise) {
      outcome.catch((error: unknown) => {
        ctx.logGateway.warn(
          `node event consumer failed node=${nodeId} event=${evt.event}: ${formatErrorMessage(error)}`,
        );
      });
    }
  };
  try {
    observeConsumerOutcome(
      consumer.subscription.handle({
        nodeId,
        payload: locationPayload as unknown as NodeLocationUpdatePayload,
      }),
    );
  } catch (error) {
    ctx.logGateway.warn(
      `node event consumer failed node=${nodeId} event=${evt.event}: ${formatErrorMessage(error)}`,
    );
  }
  // Dispatch-boundary instrumentation: event name + node id only, never
  // coordinates or accuracy. Ordinary gateway response logs omit the event
  // name, so receipt is otherwise invisible during device walks.
  // NOTE: NodeEventContext guarantees only `warn` on logGateway; calling a
  // method it does not expose throws after the consumer has run, which fails
  // the device's event response with UNAVAILABLE even though the event was
  // handled.
  ctx.logGateway.warn(`node event ${evt.event} node=${nodeId} dispatched`);
  return { ok: true, event: evt.event, handled: true, reason: "dispatched" };
}
