// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildChatItems } from "./chat-thread-build.ts";

function build(overrides: Partial<Parameters<typeof buildChatItems>[0]> = {}) {
  return buildChatItems({
    paneId: "pre-tool-dedup",
    sessionKey: "agent:main:main",
    runId: "run",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  });
}

function streamTexts(items: ReturnType<typeof buildChatItems>): string[] {
  return items.flatMap((item) => (item.kind === "stream" ? [item.text] : []));
}

describe("buildChatItems pre-tool stream dedup", () => {
  it("hides a pre-tool stream segment already persisted in history", () => {
    const items = build({
      messages: [
        { role: "user", content: "Read the file.", timestamp: 1 },
        { role: "assistant", content: "I'll inspect the file.", timestamp: 2 },
      ],
      streamSegments: [
        { text: "I'll inspect the file.", ts: 2, toolCallId: "call-read", runId: "run" },
      ],
      toolMessages: [
        {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: "file contents",
          timestamp: 3,
          runId: "run",
        },
      ],
      stream: "I'll inspect the file.",
      streamStartedAt: 2,
    });

    expect(streamTexts(items)).toEqual([]);
    expect(items.some((item) => item.kind === "group" && item.role === "assistant")).toBe(true);
  });

  it("keeps a live stream item when the text is not yet in history", () => {
    const items = build({
      messages: [{ role: "user", content: "Read the file.", timestamp: 1 }],
      stream: "I'll inspect the file.",
      streamStartedAt: 2,
    });

    expect(streamTexts(items)).toEqual(["I'll inspect the file."]);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "stream",
        text: "I'll inspect the file.",
        isStreaming: true,
      }),
    );
  });

  it("still renders a later same-text stream after a new user turn", () => {
    const items = build({
      messages: [
        { role: "user", content: "Read the file.", timestamp: 1 },
        { role: "assistant", content: "I'll inspect the file.", timestamp: 2 },
        { role: "user", content: "Say that again.", timestamp: 3 },
      ],
      stream: "I'll inspect the file.",
      streamStartedAt: 4,
    });

    expect(streamTexts(items)).toEqual(["I'll inspect the file."]);
  });

  it("still renders a novel tail after a persisted prefix", () => {
    const items = build({
      messages: [
        { role: "user", content: "Read the file.", timestamp: 1 },
        { role: "assistant", content: "I'll inspect the file.", timestamp: 2 },
      ],
      streamSegments: [
        {
          text: "I'll inspect the file. It looks fine.",
          ts: 3,
          toolCallId: "call-read",
          runId: "run",
        },
      ],
    });

    expect(streamTexts(items)).toEqual(["It looks fine."]);
  });
});
