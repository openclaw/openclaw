import { describe, expect, it } from "vitest";
import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
} from "./message-extract.ts";

describe("extractTextCached", () => {
  it("matches extractText output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello there" }],
    };
    expect(extractTextCached(message)).toBe(extractText(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "user",
      content: "plain text",
    };
    expect(extractTextCached(message)).toBe("plain text");
    expect(extractTextCached(message)).toBe("plain text");
  });
});

describe("extractThinkingCached", () => {
  it("matches extractThinking output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe(extractThinking(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe("Plan A");
    expect(extractThinkingCached(message)).toBe("Plan A");
  });
});

describe("stripInboundMetadata", () => {
  it("removes Conversation info metadata block", () => {
    const message = {
      role: "user",
      content: `Conversation info (untrusted metadata):
\`\`\`json
{
  "conversation_label": "openclaw-tui"
}
\`\`\`

Hello, how are you?`,
    };
    expect(extractText(message)).toBe("Hello, how are you?");
  });

  it("removes multiple metadata blocks", () => {
    const message = {
      role: "user",
      content: `Conversation info (untrusted metadata):
\`\`\`json
{
  "conversation_label": "test"
}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{
  "label": "John"
}
\`\`\`

This is the actual message`,
    };
    expect(extractText(message)).toBe("This is the actual message");
  });

  it("keeps regular message content", () => {
    const message = {
      role: "user",
      content: "Just a normal message",
    };
    expect(extractText(message)).toBe("Just a normal message");
  });
});
