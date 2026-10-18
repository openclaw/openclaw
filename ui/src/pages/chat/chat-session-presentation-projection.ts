import { getObserver } from "@solidjs/signals";
import type { ApplicationContext } from "../../app/context.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { chatSessionPresentationKey } from "./chat-pane-session-presentation.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

/** Publish pane-visible roster facts after either a local row write or owner notification. */
export function projectChatSessionPresentation<T extends ChatPageHost>(
  state: T,
  context: ApplicationContext,
): T {
  const listeners = new Set<() => void>();
  const presentation = projectSource(state, {
    read: (owner) =>
      chatSessionPresentationKey(
        owner,
        context.sessions.state,
        selectedChatSessionRow(owner),
        context.overlays?.snapshot?.approvalQueue,
      ),
    subscribe: (_owner, notify) => {
      listeners.add(notify);
      const stop = context.sessions.subscribe(notify);
      return () => {
        listeners.delete(notify);
        stop();
      };
    },
    equality: Object.is,
  });
  for (const key of ["sessionsResult", "sessionsResultAgentId"] as const) {
    let value = state[key];
    Object.defineProperty(state, key, {
      configurable: true,
      enumerable: true,
      get() {
        if (getObserver()) {
          presentation.revision();
        }
        return value;
      },
      set(next: typeof value) {
        if (Object.is(value, next)) {
          return;
        }
        value = next;
        listeners.forEach((listener) => listener());
      },
    });
  }
  return state;
}
