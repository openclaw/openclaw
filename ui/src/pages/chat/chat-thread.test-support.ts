import { buildCachedChatItems } from "./chat-thread.ts";

export type CachedChatItemsProps = Parameters<typeof buildCachedChatItems>[0];

export function createProps(overrides: Partial<CachedChatItemsProps> = {}): CachedChatItemsProps {
  return {
    paneId: "pane-a",
    sessionKey: "main",
    runId: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

export function buildItems(overrides: Partial<CachedChatItemsProps> = {}) {
  return buildCachedChatItems(createProps(overrides));
}

export function makeMessage(
  id: string,
  seq: number,
  fields: { role?: string; timestamp?: number; runId?: string; [key: string]: unknown } = {},
) {
  const { role = "assistant", timestamp = seq * 10, runId = "run-1", ...extra } = fields;
  return { role, content: id, timestamp, __openclaw: { id, seq, runId }, ...extra };
}
