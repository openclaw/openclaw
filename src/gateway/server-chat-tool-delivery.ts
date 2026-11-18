import type { AgentEventPayload } from "../infra/agent-events.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { createSessionLifecyclePublisher } from "./server-chat-lifecycle-publication.js";
import { liveTextDelivery } from "./server-chat-live-text.js";
import type {
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { ToolEventRecipientRegistry } from "./server-chat-tool-recipients.js";

/** Stateless delivery adapter; admission, sequencing and recovery remain with the chat owner. */
export function createAgentToolEventDelivery({
  broadcastToConnIds,
  chatRunState,
  toolEventRecipients,
  sessionEventSubscribers,
  sessionMessageSubscribers,
  resolveSessionDeliveryKeys,
  buildSessionEventSnapshot,
  sendAgentPayload,
}: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  chatRunState: ChatRunState;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  resolveSessionDeliveryKeys: (sessionKey: string, agentId?: string) => string[];
  buildSessionEventSnapshot: ReturnType<typeof createSessionLifecyclePublisher>["buildSnapshot"];
  sendAgentPayload: (
    sessionKey: string,
    payload: AgentEventPayload,
    options: { agentId?: string; controlUiVisible: false; dropIfSlow: true },
  ) => void;
}) {
  return ({
    evt,
    clientRunId,
    sessionKey,
    sessionAgentId,
    agentPayload,
    isControlUiVisible,
    hasSessionMessageSubscribers,
  }: {
    evt: AgentEventPayload;
    clientRunId: string;
    sessionKey?: string;
    sessionAgentId?: string;
    agentPayload: AgentEventPayload;
    isControlUiVisible: boolean;
    hasSessionMessageSubscribers: boolean;
  }) => {
    const toolPhase = typeof evt.data.phase === "string" ? evt.data.phase : "";
    const outputOnly = toolPhase === "update" && evt.data.outputOnly === true;
    // Internal admission, sequence and bounded recovery at the caller remain unconditional.
    // Output-only delivery carries invocation facts; session metadata has its own publications.
    const outputRecipients = outputOnly ? new Set<string>() : undefined;
    if (outputRecipients && sessionKey) {
      for (const key of resolveSessionDeliveryKeys(sessionKey, sessionAgentId)) {
        for (const connId of sessionMessageSubscribers.getLiveToolOutput(key)) {
          outputRecipients.add(connId);
        }
      }
    }
    // Always broadcast tool events to registered WS recipients with
    // tool-events capability, regardless of verboseLevel. The verbose
    // setting only controls whether tool details are sent as channel
    // messages to messaging surfaces (Telegram, Discord, etc.). Carry the
    // delivery key so scoped clients must also own the session subscription.
    const registeredToolRecipients = toolEventRecipients.get(evt.runId);
    const runToolRecipients = outputRecipients
      ? new Set([...(registeredToolRecipients ?? [])].filter((id) => outputRecipients.has(id)))
      : registeredToolRecipients;
    if (isControlUiVisible && runToolRecipients && runToolRecipients.size > 0) {
      broadcastToConnIds(
        "agent",
        sessionKey && !outputOnly
          ? {
              ...agentPayload,
              ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId),
            }
          : agentPayload,
        runToolRecipients,
        {
          sessionKeys: sessionKey
            ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId)
            : undefined,
          liveText: liveTextDelivery(chatRunState, clientRunId),
        },
      );
    }
    if (
      !isControlUiVisible &&
      sessionKey &&
      hasSessionMessageSubscribers &&
      (!outputRecipients || outputRecipients.size > 0)
    ) {
      const toolPayload = outputOnly
        ? agentPayload
        : {
            ...agentPayload,
            ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId),
          };
      sendAgentPayload(sessionKey, toolPayload, {
        agentId: sessionAgentId,
        controlUiVisible: false,
        dropIfSlow: true,
      });
    }
    // Session subscribers power operator UIs that attach to an existing
    // in-flight session after the run has already started. Those clients do
    // not know the runId in advance, so they cannot register as run-scoped
    // tool recipients. Mirror tool lifecycle onto a session-scoped event so
    // they can render live pending tool cards without polling history.
    if (isControlUiVisible && sessionKey) {
      const sessionSubscribers = new Set(outputRecipients ?? sessionEventSubscribers.getAll());
      for (const connId of runToolRecipients ?? []) {
        sessionSubscribers.delete(connId);
      }
      if (sessionSubscribers.size > 0) {
        broadcastToConnIds("session.tool", agentPayload, sessionSubscribers, {
          sessionKeys: resolveSessionDeliveryKeys(sessionKey, sessionAgentId),
          dropIfSlow: true,
          liveText: liveTextDelivery(chatRunState, clientRunId),
        });
      }
    }
  };
}
