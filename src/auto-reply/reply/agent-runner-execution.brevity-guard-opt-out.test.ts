import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReplyPayload } from "../types.js";
import { applyOpenAIGptChatReplyGuard } from "./agent-runner-execution.js";

const ENV_KEY = "OPENCLAW_DISABLE_GPT_CHAT_BREVITY_GUARD";

function buildChattyText(): string {
  const para = (label: string) =>
    `${label} sentence one. ${label} sentence two. ${label} sentence three. ${label} sentence four. ${label} sentence five.`;
  // 3 paragraphs, 15 sentences total, ~ > 1500 chars after padding, includes summary phrase.
  const filler = "x".repeat(1_200);
  return [
    para("First"),
    para("Second"),
    `${para("Third")} In summary, here is what changed. ${filler}`,
  ].join("\n\n");
}

function makePayload(text: string): ReplyPayload {
  return { text };
}

describe("applyOpenAIGptChatReplyGuard opt-out", () => {
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previousEnv;
    }
  });

  it("shortens chatty replies for openai gpt-5 by default (baseline)", () => {
    const text = buildChattyText();
    const payload = makePayload(text);
    applyOpenAIGptChatReplyGuard({
      provider: "openai",
      model: "gpt-5",
      commandBody: "hello there",
      isHeartbeat: false,
      payloads: [payload],
    });
    expect(payload.text).not.toBe(text);
    expect(payload.text!.endsWith("...")).toBe(true);
    expect(payload.text!.length).toBeLessThan(text.length);
  });

  it("leaves replies untouched when the env opt-out is enabled", () => {
    process.env[ENV_KEY] = "1";
    const text = buildChattyText();
    const payload = makePayload(text);
    applyOpenAIGptChatReplyGuard({
      provider: "openai",
      model: "gpt-5",
      commandBody: "hello there",
      isHeartbeat: false,
      payloads: [payload],
    });
    expect(payload.text).toBe(text);
  });

  it("accepts case-insensitive 'true' as the opt-out value", () => {
    process.env[ENV_KEY] = "TRUE";
    const text = buildChattyText();
    const payload = makePayload(text);
    applyOpenAIGptChatReplyGuard({
      provider: "openai",
      model: "gpt-5",
      commandBody: "hello there",
      isHeartbeat: false,
      payloads: [payload],
    });
    expect(payload.text).toBe(text);
  });
});
