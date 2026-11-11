import type { SessionObserverState } from "./session-observer-model.js";

// The Control UI opens at most six live session subscriptions; matching that cap
// prevents background observer calls from outgrowing the surface consuming them.
const MAX_CONCURRENT_MODEL_SESSIONS = 6;

export function createSessionObserverModelSlots(params: {
  states: Map<string, SessionObserverState>;
  resolve: (agentId: string) => string | undefined;
  demote: (state: SessionObserverState) => void;
}) {
  const demoted = new WeakSet<SessionObserverState>();
  const running = new Set<SessionObserverState>();

  return {
    reserve(state: SessionObserverState): boolean {
      if (running.has(state) || running.size >= MAX_CONCURRENT_MODEL_SESSIONS) {
        return false;
      }
      // Logical eviction can remove a state before its aborted work settles.
      // Only the completion owner releases this physical reservation.
      running.add(state);
      return true;
    },
    release(state: SessionObserverState): void {
      running.delete(state);
    },
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
      if (occupied >= MAX_CONCURRENT_MODEL_SESSIONS) {
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
