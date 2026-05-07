import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

function textMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as AgentMessage;
}

function cfg(mode: "tools" | "off", patterns?: string[]): OpenClawConfig {
  return {
    logging: {
      redactSensitive: mode,
      ...(patterns ? { redactPatterns: patterns } : {}),
    },
  } satisfies OpenClawConfig;
}

const EMAIL_PATTERN = String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`;

describe("redactTranscriptMessage", () => {
  it("redacts text block matching default patterns (sk- token)", () => {
    const msg = textMessage("key is sk-abcdef1234567890xyz end");
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("sk-abcdef1234567890xyz");
    expect(text).toContain("end");
  });

  it("redacts thinking block", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret sk-abcdef1234567890xyz", thinkingSignature: "sig" },
      ],
    } as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (result.content as Array<{ thinking: string }>)[0];
    expect(block.thinking).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts partialJson block", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "toolCallDelta", partialJson: '{"key":"sk-abcdef1234567890xyz"}' }],
    } as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("tools"));
    const block = (result.content as Array<{ partialJson: string }>)[0];
    expect(block.partialJson).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts string-form content", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "my key is sk-abcdef1234567890xyz",
    } as AgentMessage;
    const result = redactTranscriptMessage(msg, cfg("tools"));
    expect(result.content as string).not.toContain("sk-abcdef1234567890xyz");
  });

  it("redacts using custom pattern", () => {
    const msg = textMessage("email peter@dc.io ok");
    const result = redactTranscriptMessage(msg, cfg("tools", [EMAIL_PATTERN]));
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("peter@dc.io");
    expect(text).toContain("ok");
  });

  it("passes through unchanged when redactSensitive is off", () => {
    const msg = textMessage("key is sk-abcdef1234567890xyz");
    const result = redactTranscriptMessage(msg, cfg("off"));
    expect(result).toBe(msg); // same reference — nothing changed
  });

  it("returns same object reference when nothing matches", () => {
    const msg = textMessage("nothing sensitive here");
    const result = redactTranscriptMessage(msg, cfg("tools"));
    expect(result).toBe(msg);
  });

  it("redacts with cfg=undefined (falls back to default patterns)", () => {
    const msg = textMessage("key is sk-abcdef1234567890xyz");
    const result = redactTranscriptMessage(msg, undefined);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain("sk-abcdef1234567890xyz");
  });

  it("passes through non-object and null blocks without throwing", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [null, 42, "raw string"] as unknown as [],
    } as AgentMessage;
    expect(() => redactTranscriptMessage(msg, cfg("tools"))).not.toThrow();
  });
});
