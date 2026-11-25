import { createInitializationContext } from "./chat-application-context.test-support.ts";
import { registerChatHostCleanup } from "./chat-host.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";

export function createTestPageState<
  T extends Pick<ChatPageHost, "client" | "sessions" | "sessionKey">,
>(host: T): ChatPageHost & T {
  const state = Object.assign(
    createPageState(
      { ...createInitializationContext(host.client ?? undefined), sessions: host.sessions },
      { afterCommit: () => () => {} },
      { sessionKey: host.sessionKey, dispatchEvent: () => true },
    ),
    host,
  );
  registerChatHostCleanup(state);
  return state;
}
