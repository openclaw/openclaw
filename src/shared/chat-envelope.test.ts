import { describe, expect, it } from "vitest";
import { stripEnvelope, stripMessageIdHints } from "./chat-envelope.js";

describe("stripEnvelope", () => {
  it("returns unchanged text without envelope", () => {
    expect(stripEnvelope("Hello world")).toBe("Hello world");
    expect(stripEnvelope("")).toBe("");
  });

  it("strips WebChat envelope", () => {
    const result = stripEnvelope("[WebChat] Hello");
    expect(result).toBe("Hello");
  });

  it("strips WhatsApp envelope", () => {
    const result = stripEnvelope("[WhatsApp 2024-01-15 10:30] Message");
    expect(result).toBe("Message");
  });

  it("strips Telegram envelope with timestamp", () => {
    const result = stripEnvelope("[Telegram 2024-01-15T10:30:00Z] Hello");
    expect(result).toBe("Hello");
  });

  it("strips Discord envelope", () => {
    const result = stripEnvelope("[Discord] Hello world");
    expect(result).toBe("Hello world");
  });

  it("keeps text without matching envelope header", () => {
    expect(stripEnvelope("[Unknown] Hello")).toBe("[Unknown] Hello");
    expect(stripEnvelope("[Random Text] Hello")).toBe("[Random Text] Hello");
  });

  it("handles envelopes with extra whitespace", () => {
    const result = stripEnvelope("[WebChat]   Hello");
    expect(result).toBe("Hello");
  });
});

describe("stripMessageIdHints", () => {
  it("returns unchanged text without message_id hints", () => {
    expect(stripMessageIdHints("Hello world")).toBe("Hello world");
  });

  it("strips single message_id line", () => {
    const text = "Hello\n[message_id: abc123]\nWorld";
    const result = stripMessageIdHints(text);
    expect(result).not.toContain("message_id");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });

  it("strips multiple message_id lines", () => {
    const text = "[message_id: abc]\nHello\n[message_id: def]\nWorld";
    const result = stripMessageIdHints(text);
    expect(result).not.toContain("message_id");
  });

  it("keeps text unchanged if no message_id found", () => {
    const text = "Hello [message: 123] World";
    expect(stripMessageIdHints(text)).toBe(text);
  });

  it("handles case-insensitive matching", () => {
    const text = "Hello\n[MESSAGE_ID: abc]\nWorld";
    expect(stripMessageIdHints(text)).not.toContain("MESSAGE_ID");
  });

  it("preserves non-message_id bracket content", () => {
    const text = "Hello [other: value] World";
    expect(stripMessageIdHints(text)).toBe(text);
  });
});
