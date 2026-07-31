import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { sessionObserverScopeKey } from "./session-observer-model.js";

export function createSessionObserverAudience(params: {
  subscribers: SessionMessageSubscriberRegistry;
  sessionEventSubscribers?: SessionEventSubscriberRegistry;
  isVisible: (connId: string) => boolean;
  getConfig: () => OpenClawConfig;
}) {
  const messageSubscriberKeys = (sessionKey: string, agentId: string): string[] => {
    // sessions.messages.subscribe canonicalizes selected-agent global aliases
    // to this same qualified key before registering the connection.
    const scopedKey = sessionObserverScopeKey(sessionKey, agentId);
    const cfg = params.getConfig();
    const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
    if (
      sessionKey === "global" &&
      compatibilityAgentId !== undefined &&
      normalizeAgentId(agentId) === normalizeAgentId(compatibilityAgentId)
    ) {
      // Keep legacy default-agent global subscribers while non-default global
      // sessions remain confined to their agent-qualified stream.
      return [scopedKey, sessionKey];
    }
    return [scopedKey];
  };

  const messageRecipients = (sessionKey: string, agentId: string): Set<string> => {
    const recipients = new Set<string>();
    for (const key of messageSubscriberKeys(sessionKey, agentId)) {
      for (const connId of params.subscribers.get(key)) {
        recipients.add(connId);
      }
    }
    return recipients;
  };

  return {
    has(sessionKey: string, agentId: string): boolean {
      for (const connId of messageRecipients(sessionKey, agentId)) {
        if (params.isVisible(connId)) {
          return true;
        }
      }
      for (const connId of params.sessionEventSubscribers?.getAll() ?? []) {
        if (params.isVisible(connId)) {
          return true;
        }
      }
      return false;
    },

    recipients(sessionKey: string, agentId: string): ReadonlySet<string> {
      const recipients = messageRecipients(sessionKey, agentId);
      for (const connId of params.sessionEventSubscribers?.getAll() ?? []) {
        if (params.isVisible(connId)) {
          recipients.add(connId);
        }
      }
      return recipients;
    },

    criticalRecipients(sessionKey: string, agentId: string): ReadonlySet<string> {
      const recipients = messageRecipients(sessionKey, agentId);
      // sessions.subscribe is operator.read-gated. Critical fanout drops only
      // Control UI visibility, preserving the existing subscription boundary.
      for (const connId of params.sessionEventSubscribers?.getAll() ?? []) {
        recipients.add(connId);
      }
      return recipients;
    },
  };
}
