// Tests usage-line formatting for agent runner completion summaries.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("preserves reply payload metadata when appending usage text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = appendUsageLine([payload], "Usage: 12 in / 3 out");

    expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(expectDefined(updated, "updated test invariant"))).toMatchObject(
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          idempotencyKey: "run-1:internal-source-reply:0",
          text: "message tool reply\nUsage: 12 in / 3 out",
        },
      },
    );
  });
});

describe("resolveResponseUsageLine — braille glyph scrubbing for WebChat", () => {
  // Minimal config shape used by resolveResponseUsageLine; casts through unknown
  // to keep this test focused without depending on the full OpenClawConfig tree.
  const config = { messages: {} } as unknown as OpenClawConfig;
  const replyUsageState: PluginHookReplyUsageState = {
    provider: "openai",
    model: "gpt-5",
    agentId: "main",
    sessionId: "session-1",
    contextTokenBudget: 128_000,
    contextUsedTokens: 96_000, // triggers braille meter render (~75%)
    usage: { input: 100, output: 50 },
  } as PluginHookReplyUsageState;

  it("strips U+2800–U+28FF braille glyphs from the usage line when channel is webchat", () => {
    const line = resolveResponseUsageLine({
      config,
      sessionRaw: "full",
      channel: "webchat",
      usage: { input: 100, output: 50 },
      provider: "openai",
      model: "gpt-5",
      replyUsageState,
    });
    expect(line, "resolveResponseUsageLine should emit a usage line").toBeDefined();
    // Regression for issue #105481: any leaked U+2800–U+28FF codepoint makes
    // markdown-it treat the whole message as a binary/image payload in WebChat.
    expect(line).not.toMatch(/[\u2800-\u28FF]/u);
  });

  it("keeps braille glyphs intact on non-webchat channels (discord, tui)", () => {
    const discordLine = resolveResponseUsageLine({
      config,
      sessionRaw: "full",
      channel: "discord",
      usage: { input: 100, output: 50 },
      provider: "openai",
      model: "gpt-5",
      replyUsageState,
    });
    expect(discordLine).toBeDefined();
    expect(discordLine).toMatch(/[\u2800-\u28FF]/u);
  });
});
