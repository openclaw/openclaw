import { expect } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import type { makeChatHost } from "./chat-host.test-support.ts";
import { admitStoredChatComposerQueueItemResult } from "./composer-queue-persistence.ts";
type TestChatHost = ReturnType<typeof makeChatHost>;

export function admitHostQueueItems(host: TestChatHost): void {
  for (const item of host.chatQueue) {
    const admission = captureChatOutboxAdmission(
      host,
      item.sessionKey ?? host.sessionKey,
      item.agentId,
    );
    expect(admitStoredChatComposerQueueItemResult(host, admission, item)).toBe("admitted");
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

export function createQueuedLocalCommand(
  id: string,
  text: string,
  { createdAt = 1, sessionKey = "agent:main" }: { createdAt?: number; sessionKey?: string } = {},
) {
  const [localCommandName = "", ...args] = text.slice(1).split(" ");
  return { id, text, createdAt, sessionKey, localCommandName, localCommandArgs: args.join(" ") };
}
