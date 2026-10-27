// Serialized into the browser mock, like the session and response fixture owners.
export function createControlUiMockSessionSubscriptions(
  scenario: {
    mainSessionKey: string;
    defaultAgentId: string;
    sessionScope: string;
    subscriptionInitialHistory: boolean;
  },
  isRecord: (value: unknown) => value is Record<string, unknown>,
) {
  const scopedEvents = new Set(
    "agent chat chat.side_result session.observer session.tool".split(" "),
  );
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
    subscribeResponse(params: unknown, readHistory: (params: Record<string, unknown>) => unknown) {
      const key = canonicalKey(
        isRecord(params) && typeof params.key === "string" ? params.key : "",
      );
      if (
        !scenario.subscriptionInitialHistory ||
        !isRecord(params) ||
        !isRecord(params.initialHistory)
      ) {
        return { key };
      }
      const payload = readHistory({
        ...params.initialHistory,
        sessionKey: key,
        agentId: params.agentId,
      });
      const error = isRecord(payload) ? payload["__mockError"] : undefined;
      return {
        key,
        initialHistory: isRecord(error) ? { ok: false, error } : { ok: true, payload },
      };
    },
    createClient(lifecycle?: {
      isOpen: () => boolean;
      startRepeatingEvents: () => void;
      stopRepeatingEvents: () => void;
    }) {
      const observers = new Map<string, string>();
      let capabilities: readonly unknown[] = [];
      let observesSessions = false;
      const hasCapability = (capability: string) => capabilities.includes(capability);
      const hasSubscription = (payload: unknown): boolean => {
        const candidates = isRecord(payload) ? [payload, payload.suggestion, payload.request] : [];
        const source = candidates.find(
          (candidate): candidate is { sessionKey: string; agentId?: unknown } =>
            isRecord(candidate) &&
            typeof candidate.sessionKey === "string" &&
            Boolean(candidate.sessionKey.trim()),
        );
        return Boolean(
          source &&
          [...observers.values()].includes(subscriptionKey(source.sessionKey, source.agentId)),
        );
      };
      return {
        hasCapability,
        hasSubscription,
        get size() {
          return observers.size;
        },
        clear() {
          observers.clear();
          observesSessions = false;
        },
        recordRequest(method: string, params: unknown, result?: unknown) {
          if ((lifecycle && !lifecycle.isOpen()) || !isRecord(params)) {
            return;
          }
          if (method === "connect") {
            capabilities = Array.isArray(params.caps) ? params.caps : [];
          } else if (method === "sessions.subscribe") {
            observesSessions = isRecord(result) && result.subscribed === true;
          } else if (typeof params.key === "string" && params.key.trim()) {
            const key = subscriptionKey(params.key, params.agentId);
            const observer =
              typeof params.subscriptionId === "string" ? params.subscriptionId : key;
            if (method === "sessions.messages.subscribe") {
              observers.set(observer, key);
              lifecycle?.startRepeatingEvents();
            } else if (method === "sessions.messages.unsubscribe") {
              observers.delete(observer);
              if (observers.size === 0) {
                lifecycle?.stopRepeatingEvents();
              }
            }
          }
        },
        allows(event: string, payload: unknown): boolean {
          // Broad observers receive summaries, never unscoped tool/transcript events.
          return (
            (event === "session.observer" && observesSessions) ||
            (event !== "session.typing" &&
              !(hasCapability("session-scoped-events") && scopedEvents.has(event))) ||
            hasSubscription(payload)
          );
        },
      };
    },
  };
}
