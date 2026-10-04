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
