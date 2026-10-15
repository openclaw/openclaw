import type { SessionObserverState } from "./session-observer-model.js";

export function createSessionObserverModelSlots(params: {
  states: Map<string, SessionObserverState>;
  maxSessions: number;
  resolve: (agentId: string) => string | undefined;
  demote: (state: SessionObserverState) => void;
}) {
  const demoted = new WeakSet<SessionObserverState>();

  return {
    claim(agentId: string, current?: SessionObserverState): string | undefined {
      const resolved = params.resolve(agentId);
      if (!resolved || current?.utilityModelRef === resolved) {
        return resolved;
      }
      let occupied = 0;
      let evicted: SessionObserverState | undefined;
      for (const state of params.states.values()) {
        if (state === current || !state.utilityModelRef) {
          continue;
        }
        occupied += 1;
        if (
          !state.terminalHealth &&
          !state.finalPending &&
          (!evicted ||
            (state.lastActivityAt - evicted.lastActivityAt ||
              state.sessionKey.localeCompare(evicted.sessionKey)) < 0)
        ) {
          evicted = state;
        }
      }
      if (occupied >= params.maxSessions) {
        if ((current && demoted.has(current)) || !evicted) {
          return undefined;
        }
        demoted.add(evicted);
        params.demote(evicted);
      } else if (current) {
        demoted.delete(current);
      }
      return resolved;
    },
  };
}
