// Control UI tests cover native-runtime tool input rendering (#110769).
import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { extractToolCardsCached as extractToolCards } from "../../lib/chat/tool-cards.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

type CachedChatItemsProps = Parameters<typeof buildCachedChatItems>[0];

function createProps(overrides: Partial<CachedChatItemsProps> = {}): CachedChatItemsProps {
  return {
    paneId: "pane-native-input",
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

function allToolCards(props: Partial<CachedChatItemsProps>) {
  resetChatThreadState();
  const groups = buildCachedChatItems(createProps(props)).filter(
    (item): item is MessageGroup => item.kind === "group",
  );
  return groups.flatMap((group) =>
    group.messages.flatMap((entry) => extractToolCards(entry.message, entry.key)),
  );
}

const baseMessage = {
  message_id: 100,
  date: 1_700_000_000,
  chat: { id: 4242, type: "private" as const, first_name: "Alice" },
  from: { id: 42, is_bot: false as const, first_name: "Alice" },
};

describe("native-runtime transcript tool input (#110769)", () => {
  const assistantWithToolCall = {
    ...baseMessage,
    role: "assistant",
    timestamp: 100,
    content: [
      { type: "text", text: "Let me look that up." },
      {
        type: "toolCall",
        id: "toolu_EXAMPLE",
        name: "example_tool",
        arguments: { query: "example" },
      },
    ],
  };
  const nativeToolResult = {
    ...baseMessage,
    role: "toolResult",
    timestamp: 200,
    toolCallId: "toolu_EXAMPLE",
    toolName: "example_tool",
    content: [{ type: "text", text: '{ "result": "ok" }' }],
  };

  it("renders both input and output when call and result are separate messages", () => {
    const cards = allToolCards({ messages: [assistantWithToolCall, nativeToolResult] });
    const merged = cards.filter((card) => card.name === "example_tool");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.inputText).toContain("example");
    expect(merged[0]?.outputText).toContain("result");
  });

  it("renders both input and output when the result arrives via toolMessages", () => {
    const cards = allToolCards({
      messages: [assistantWithToolCall],
      toolMessages: [nativeToolResult],
    });
    const merged = cards.filter((card) => card.name === "example_tool");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.inputText).toContain("example");
    expect(merged[0]?.outputText).toContain("result");
  });

  it("renders both input and output when the result timestamp precedes the call", () => {
    const earlyResult = { ...nativeToolResult, timestamp: 50 };
    const cards = allToolCards({ messages: [assistantWithToolCall, earlyResult] });
    const merged = cards.filter((card) => card.name === "example_tool");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.inputText).toContain("example");
    expect(merged[0]?.outputText).toContain("result");
  });

  it("renders both input and output when the result is listed before the call", () => {
    const cards = allToolCards({ messages: [nativeToolResult, assistantWithToolCall] });
    const merged = cards.filter((card) => card.name === "example_tool");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.inputText).toContain("example");
    expect(merged[0]?.outputText).toContain("result");
  });

  it("pairs multiple tool calls with earlier-sorted orphan results", () => {
    const multiCallAssistant = {
      ...baseMessage,
      role: "assistant",
      timestamp: 200,
      content: [
        { type: "text", text: "I will use two tools." },
        {
          type: "toolCall",
          id: "call_alpha",
          name: "alpha_tool",
          arguments: { key: "alpha-val" },
        },
        {
          type: "toolCall",
          id: "call_beta",
          name: "beta_tool",
          arguments: { key: "beta-val" },
        },
        {
          type: "toolCall",
          id: "call_gamma",
          name: "gamma_tool",
          arguments: { key: "gamma-val" },
        },
      ],
    };
    const earlyResults = [
      {
        ...baseMessage,
        role: "toolResult",
        timestamp: 100,
        toolCallId: "call_alpha",
        toolName: "alpha_tool",
        content: [{ type: "text", text: "alpha done" }],
      },
      {
        ...baseMessage,
        role: "toolResult",
        timestamp: 150,
        toolCallId: "call_gamma",
        toolName: "gamma_tool",
        content: [{ type: "text", text: "gamma done" }],
      },
      // call_beta has no orphaned result — it stays unmatched
    ];
    const cards = allToolCards({ messages: [multiCallAssistant, ...earlyResults] });

    const alphaCards = cards.filter((card) => card.name === "alpha_tool");
    expect(alphaCards).toHaveLength(1);
    expect(alphaCards[0]?.inputText).toContain("alpha-val");
    expect(alphaCards[0]?.outputText).toContain("alpha done");

    const gammaCards = cards.filter((card) => card.name === "gamma_tool");
    expect(gammaCards).toHaveLength(1);
    expect(gammaCards[0]?.inputText).toContain("gamma-val");
    expect(gammaCards[0]?.outputText).toContain("gamma done");

    // call_beta stays as input-only; it never had an orphan result to merge with
    const betaCards = cards.filter((card) => card.name === "beta_tool");
    expect(betaCards).toHaveLength(1);
    expect(betaCards[0]?.inputText).toContain("beta-val");
    expect(betaCards[0]?.outputText).toBeUndefined();
  });
});
