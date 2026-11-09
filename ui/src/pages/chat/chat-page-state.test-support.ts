import { createInitializationContext } from "./chat-application-context.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";

export function createTestPageState<
  T extends Pick<ChatPageHost, "client" | "sessions" | "sessionKey">,
>(host: T): ChatPageHost & T {
  return Object.assign(
    createPageState(
      { ...createInitializationContext(host.client ?? undefined), sessions: host.sessions },
      { afterCommit: () => () => {} },
      { sessionKey: host.sessionKey, dispatchEvent: () => true },
    ),
    host,
  );
}
