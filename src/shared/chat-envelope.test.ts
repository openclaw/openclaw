import { describe, it, expect } from "vitest";
import { stripEnvelope, stripInboundMeta, stripMessageIdHints } from "./chat-envelope.js";

describe("stripInboundMeta", () => {
  it("strips conversation info metadata block", () => {
    const input = `Hello world

Conversation info (untrusted metadata):
\`\`\`json
{
  "schema": "openclaw.inbound_meta.v1",
  "channel": "webchat"
}
\`\`\``;
    expect(stripInboundMeta(input)).toBe("Hello world");
  });

  it("strips sender metadata block", () => {
    const input = `Hi there
Sender (untrusted metadata):
\`\`\`json
{"name": "Alice"}
\`\`\``;
    expect(stripInboundMeta(input)).toBe("Hi there");
  });

  it("strips forwarded message context block", () => {
    const input = `Check this out
Forwarded message context (untrusted metadata):
\`\`\`json
{"from": "Bob"}
\`\`\``;
    expect(stripInboundMeta(input)).toBe("Check this out");
  });

  it("strips multiple metadata blocks", () => {
    const input = `Hello
Conversation info (untrusted metadata):
\`\`\`json
{"channel": "webchat"}
\`\`\`
Sender (untrusted metadata):
\`\`\`json
{"name": "Alice"}
\`\`\``;
    expect(stripInboundMeta(input)).toBe("Hello");
  });

  it("returns text unchanged when no metadata present", () => {
    const input = "Just a normal message with no metadata";
    expect(stripInboundMeta(input)).toBe(input);
  });

  it("handles metadata-only messages", () => {
    const input = `Conversation info (untrusted metadata):
\`\`\`json
{"channel": "webchat"}
\`\`\``;
    expect(stripInboundMeta(input)).toBe("");
  });
});

describe("stripEnvelope", () => {
  it("strips WebChat envelope prefix", () => {
    expect(stripEnvelope("[WebChat 2026-02-20 12:00Z] Hello")).toBe("Hello");
  });

  it("leaves non-envelope text unchanged", () => {
    expect(stripEnvelope("Hello world")).toBe("Hello world");
  });
});
