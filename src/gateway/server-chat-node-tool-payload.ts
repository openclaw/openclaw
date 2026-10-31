import type { VerboseLevel } from "../auto-reply/thinking.shared.js";
import type { AgentEventPayload, AgentEventRuntimePayload } from "../infra/agent-events.js";
import type { createSessionLifecyclePublisher } from "./server-chat-lifecycle-publication.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

export function createNodeToolPayloadSender({
  resolveSessionDeliveryKeys,
  nodeHasSessionSubscribers,
  resolveToolVerboseLevel,
  buildSessionEventSnapshot,
  nodeSendToSession,
}: {
  nodeHasSessionSubscribers: (sessionKey: string) => boolean;
  nodeSendToSession: GatewayRequestContext["nodeSendToSession"];
  resolveSessionDeliveryKeys: (sessionKey: string, agentId?: string) => string[];
  resolveToolVerboseLevel: (
    event: AgentEventRuntimePayload,
    sessionKey: string,
    agentId: string | undefined,
  ) => VerboseLevel;
  buildSessionEventSnapshot: ReturnType<typeof createSessionLifecyclePublisher>["buildSnapshot"];
}) {
  return (
    event: AgentEventRuntimePayload,
    sessionKey: string,
    agentId: string | undefined,
    payload: AgentEventPayload,
  ) => {
    // Incomplete widget source is a transient Control UI projection, never channel output.
    if (event.data.phase === "widget_preview") {
      return;
    }
    const deliveryKeys = resolveSessionDeliveryKeys(sessionKey, agentId).filter(
      nodeHasSessionSubscribers,
    );
    const firstDeliveryKey = deliveryKeys[0];
    if (!firstDeliveryKey) {
      return;
    }
    const verbose = resolveToolVerboseLevel(event, sessionKey, agentId);
    if (verbose === "off") {
      return;
    }
    let channelPayload = payload;
    if (verbose !== "full") {
      const data = { ...event.data };
      delete data.result;
      delete data.partialResult;
      channelPayload = { ...payload, data };
    }
    const nodePayload = {
      ...channelPayload,
      ...buildSessionEventSnapshot(sessionKey, undefined, agentId),
    };
    // Registration is demand only; each send still validates its pairing generation.
    nodeSendToSession(firstDeliveryKey, "agent", nodePayload, { sessionKeys: deliveryKeys });
  };
}
