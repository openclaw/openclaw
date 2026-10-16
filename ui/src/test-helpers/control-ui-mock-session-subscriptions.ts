// Serialized into the browser mock, like the session and response fixture owners.
export function createControlUiMockSessionSubscriptions(
  scenario: { mainSessionKey: string; defaultAgentId: string; sessionScope: string },
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  const scopedEvents = new Set([
    "agent",
    "chat",
    "chat.side_result",
    "session.observer",
    "session.tool",
  ]);
  const canonicalKey = (key: string): string => {
    const normalized = key.trim();
    if (scenario.sessionScope === "global" && /^agent:[^:]+:main$/u.test(normalized)) {
      return "global";
    }
    return normalized === "main" ? scenario.mainSessionKey : normalized;
  };
  const subscriptionKey = (key: string, agentId: unknown): string => {
    const canonical = canonicalKey(key);
    return canonical === "global"
      ? `agent:${/^agent:([^:]+):main$/u.exec(key)?.[1] ?? (typeof agentId === "string" ? agentId : scenario.defaultAgentId)}:global`
      : canonical;
  };
  return {
    canonicalKey,
    createClient(lifecycle?: {
      isOpen: () => boolean;
      startRepeatingEvents: () => void;
      stopRepeatingEvents: () => void;
    }) {
      const keys = new Set<string>();
      let scoped = false;
      let observesSessions = false;
      const hasSubscription = (payload: unknown): boolean => {
        const source = isRecord(payload)
          ? [payload, payload.suggestion, payload.request].find(
              (candidate) =>
                isRecord(candidate) &&
                typeof candidate.sessionKey === "string" &&
                candidate.sessionKey.trim(),
            )
          : undefined;
        return (
          isRecord(source) &&
          typeof source.sessionKey === "string" &&
          keys.has(subscriptionKey(source.sessionKey, source.agentId))
        );
      };
      return {
        hasSubscription,
        get size() {
          return keys.size;
        },
        clear() {
          keys.clear();
          observesSessions = false;
        },
        recordRequest(method: string, params: unknown, result?: unknown) {
          if ((lifecycle && !lifecycle.isOpen()) || !isRecord(params)) {
            return;
          }
          if (method === "connect") {
            scoped = Array.isArray(params.caps) && params.caps.includes("session-scoped-events");
          } else if (method === "sessions.subscribe") {
            observesSessions = isRecord(result) && result.subscribed === true;
          } else if (typeof params.key === "string" && params.key.trim()) {
            const key = subscriptionKey(params.key, params.agentId);
            if (method === "sessions.messages.subscribe") {
              keys.add(key);
              lifecycle?.startRepeatingEvents();
            } else if (method === "sessions.messages.unsubscribe") {
              keys.delete(key);
              if (keys.size === 0) {
                lifecycle?.stopRepeatingEvents();
              }
            }
          }
        },
        allows(event: string, payload: unknown): boolean {
          // The real observer audience includes broad session-list subscribers,
          // while tool arguments and transcript events still require a child subscription.
          if (event === "session.observer" && observesSessions) {
            return true;
          }
          if (event !== "session.typing" && !(scoped && scopedEvents.has(event))) {
            return true;
          }
          return hasSubscription(payload);
        },
      };
    },
  };
}
