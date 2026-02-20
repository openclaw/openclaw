import { describe, expect, it } from "vitest";
import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
  stripInboundMetadataPrefix,
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

  it("strips inbound metadata preamble from user content", () => {
    const message = {
      role: "user",
      content:
        'Conversation info (untrusted metadata):\n```json\n{"message_id":"m1"}\n```\n\nSender (untrusted metadata):\n```json\n{"name":"Alice"}\n```\nHello there',
    };
    expect(extractTextCached(message)).toBe("Hello there");
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

  it("keeps non-user content untouched", () => {
    const message = {
      role: "assistant",
      content: 'Conversation info (untrusted metadata):\n```json\n{"message_id":"m1"}\n```\nHello',
    };
    expect(extractTextCached(message)).toBe(
      'Conversation info (untrusted metadata):\n```json\n{"message_id":"m1"}\n```\nHello',
    );
  });
});

describe("stripInboundMetadataPrefix", () => {
  it("returns only user text when prefix is present", () => {
    expect(
      stripInboundMetadataPrefix(
        'Conversation info (untrusted metadata):\n```json\n{"sender":"Alice"}\n```\n\nHello',
      ),
    ).toBe("Hello");
  });

  it("keeps text when no metadata prefix exists", () => {
    expect(stripInboundMetadataPrefix("Hello there")).toBe("Hello there");
  });

  it("strips multiple metadata blocks", () => {
    const input =
      'Conversation info (untrusted metadata):\n```json\n{"conversation":"thread"}\n```\n\nSender (untrusted metadata):\n```json\n{"name":"Alice"}\n```\nReplied message (untrusted, for context):\n```json\n{"body":"Hi"}\n```\nHello';
    expect(stripInboundMetadataPrefix(input)).toBe("Hello");
  });

  it("returns empty string when only metadata is present", () => {
    expect(
      stripInboundMetadataPrefix(
        'Conversation info (untrusted metadata):\n```json\n{"id":"abc"}\n```',
      ),
    ).toBe("");
  });
});
