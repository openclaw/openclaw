// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildCachedChatItems } from "./chat-thread.ts";

type CachedChatItemsProps = Parameters<typeof buildCachedChatItems>[0];

function createProps(overrides: Partial<CachedChatItemsProps> = {}): CachedChatItemsProps {
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

describe("live commentary stream visibility", () => {
  it("hides MiniMax-tagged narration while keeping ordinary commentary and provider-keyed progress", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          {
            text: "MiniMax internal context noted for this tool turn.",
            ts: 0,
            itemId: "minimax-commentary-0-aaaaaaaaaaaaaaaaaaaaaaaa",
          },
          {
            text: "Anthropic-style pre-tool progress text",
            ts: 1,
            itemId: "commentary-0-cccccccccccccccccccccccc",
          },
          {
            text: "Provider keyed progress text",
            ts: 2,
            itemId: "msg_progress",
          },
          {
            text: "Here is the final answer.",
            ts: 4,
            itemId: "final-answer-1-bbbbbbbbbbbbbbbbbbbbbbbb",
          },
        ],
        toolMessages: [
          {
            role: "toolResult",
            content: "Tool output",
            timestamp: 3,
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "Anthropic-style pre-tool progress text", startedAt: 1 },
      { kind: "stream", text: "Provider keyed progress text", startedAt: 2 },
      { kind: "group", role: "tool" },
      { kind: "stream", text: "Here is the final answer.", startedAt: 4 },
    ]);
    expect(items.some((item) => "text" in item && item.text.includes("MiniMax internal"))).toBe(
      false,
    );
  });

  it("keeps ordinary generated commentary visible when MiniMax narration is absent", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          {
            text: "Checking the workspace before the tool runs.",
            ts: 0,
            itemId: "commentary-0-dddddddddddddddddddddddd",
          },
          {
            text: "Provider keyed progress text",
            ts: 1,
            itemId: "msg_progress",
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "Checking the workspace before the tool runs.", startedAt: 0 },
      { kind: "stream", text: "Provider keyed progress text", startedAt: 1 },
    ]);
  });
});
