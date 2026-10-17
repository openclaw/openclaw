import type { SessionDiscussionState } from "../../../../packages/gateway-protocol/src/index.js";
import { registerListener } from "../../../../src/shared/listeners.js";

/** Connection-scoped discussion facts stay synchronous while views observe their publication. */
export function createChatPaneDiscussionState() {
  const states = new Map<string, SessionDiscussionState>();
  const openUrls = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  const snapshot: {
    states: ReadonlyMap<string, SessionDiscussionState>;
    openUrls: ReadonlyMap<string, string | null>;
  } = { states, openUrls };
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    snapshot,
    subscribe: (listener: () => void) => registerListener(listeners, listener),
    record(key: string, state: SessionDiscussionState, openUrl?: string | null) {
      const previousState = states.get(key);
      const previousUrl = openUrls.get(key);
      states.set(key, state);
      if (state === "none") {
        openUrls.delete(key);
      } else if (openUrl !== undefined) {
        openUrls.set(key, openUrl);
      }
      if (previousState !== state || previousUrl !== openUrls.get(key)) {
        publish();
      }
    },
    forgetState(key: string) {
      if (states.delete(key)) {
        publish();
      }
    },
    forgetOpenUrl(key: string) {
      if (openUrls.delete(key)) {
        publish();
      }
    },
    clear() {
      if (states.size === 0 && openUrls.size === 0) {
        return;
      }
      states.clear();
      openUrls.clear();
      publish();
    },
  };
}
