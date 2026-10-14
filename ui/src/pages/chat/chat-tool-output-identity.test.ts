// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../lib/chat/tool-cards.ts";
import { buildChatItems } from "./chat-thread-build.ts";

it("preserves result references and provenance when two calls share a transcript message", () => {
  const messages = [
    {
      role: "assistant",
      runId: "run",
      timestamp: 1,
      __openclaw: { id: "calls" },
      content: ["a", "b"].map((id) => ({ type: "toolCall", id, name: "exec", arguments: {} })),
    },
    ...["a", "b"].map((id, index) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "exec",
      runId: "run",
      timestamp: index + 2,
      __openclaw: {
        id: `result-${id}`,
        truncated: index === 1,
        reason: index === 1 ? "display-cap" : undefined,
        toolOutput: {
          source: index === 0 ? "provider-response" : "execution",
          modelInput: "unverified",
          ...(index === 0 ? { outcome: "unknown" } : {}),
        },
      },
      content: [{ type: "text", text: `  ${id}\r\n` }],
    })),
  ];
  const original = structuredClone(messages);
  const items = buildChatItems({
    paneId: "output-identity",
    sessionKey: "agent:main:main",
    runId: null,
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  });
  const cards = items.flatMap((item) =>
    item.kind === "group"
      ? item.messages.flatMap(({ message }) => extractToolCardsCached(message))
      : [],
  );
  expect(cards).toMatchObject([
    {
      callId: "a",
      resultMessageId: "result-a",
      outputText: "  a\r\n",
      toolOutput: { source: "provider-response", modelInput: "unverified" },
    },
    {
      callId: "b",
      resultMessageId: "result-b",
      outputTruncated: true,
      outputText: "  b\r\n",
      toolOutput: { source: "execution", modelInput: "unverified" },
    },
  ]);
  expect(resolveToolCardOutcome(cards[0]!, false)).toBe("unknown");
  expect(messages).toEqual(original);
});

describe("raw tool text", () => {
  it("does not interpret runtime context or reply directives in standalone tool output", () => {
    const text =
      "  [[reply_to_current]]\r\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>literal<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\r\n";
    expect(
      extractToolCardsCached({
        role: "toolResult",
        toolCallId: "read",
        toolName: "read",
        content: [{ type: "text", text }],
      })[0]?.outputText,
    ).toBe(text);
  });
});
