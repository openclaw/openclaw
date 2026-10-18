import { expect } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import type { makeChatHost } from "./chat-host.test-support.ts";
import { admitStoredChatComposerQueueItem } from "./composer-persistence.ts";
type TestChatHost = ReturnType<typeof makeChatHost>;

export function admitHostQueueItems(host: TestChatHost): void {
  for (const item of host.chatQueue) {
    const admission = captureChatOutboxAdmission(
      host,
      item.sessionKey ?? host.sessionKey,
      item.agentId,
    );
    expect(admitStoredChatComposerQueueItem(host, admission, item)).toBe(true);
  }
}

export function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

export function idleChatHistory(sessionKey = "agent:main") {
  return {
    messages: [],
    sessionInfo: row(sessionKey, { hasActiveRun: false, status: "done" }),
  };
}
