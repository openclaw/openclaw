import { vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";

export const sessionKey = "agent:main:accepted-inputs";
export const sessionId = "accepted-input-session";
export const input: ChatPendingInputsPage["items"][number] = {
  id: "input-1",
  runId: "run-queued",
  acceptedAt: 100,
  state: "interrupted",
  message: {
    role: "user",
    content: "Keep my accepted input",
    timestamp: 100,
    __openclaw: { id: "pending:input-1" },
  },
};
export const page: ChatPendingInputsPage = { items: [input], total: 2, nextBefore: 2 };

export function makeChatPageHost({
  requestHandlers,
  ...overrides
}: Partial<ChatPageHost> & { requestHandlers: Record<string, unknown> }) {
  const { client, hello, request, sessions } = makeChatHost({ requestHandlers });
  const context = { ...createInitializationContext(), sessions };
  const host = createPageState(
    context,
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    { dispatchEvent: () => true, querySelector: () => null },
  );
  Object.assign(host, { client, hello, connected: true }, overrides);
  return Object.assign(host, { request });
}
