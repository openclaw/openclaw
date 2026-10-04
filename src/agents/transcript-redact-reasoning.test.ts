import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

describe("Responses reasoning transcript preservation", () => {
  it.each([
    ["github-copilot", "openclaw-openai-responses-transport"],
    ["openai", "openai-responses"],
  ])("preserves opaque reasoning for %s / %s with 1024-character ids", (provider, api) => {
    const id = "A".repeat(1024);
    const encryptedContent = "Q".repeat(32) + "/LTAI" + "B".repeat(20) + "/" + "C".repeat(6);
    const signature = JSON.stringify({
      id,
      type: "reasoning",
      summary: [],
      encrypted_content: encryptedContent,
    });
    const message = castAgentMessage({
      role: "assistant",
      provider,
      api,
      model: "gpt-5.5",
      content: [{ type: "thinking", thinking: "", thinkingSignature: signature }],
    });

    const redacted = redactTranscriptMessage(message);

    expect(redacted).toMatchObject({
      content: [{ thinkingSignature: signature }],
    });
    expect(JSON.stringify(redacted)).not.toContain("\u2026");
  });
});

const SYNTHETIC_CIPHERTEXT = `gAAAA${"synthetic-base64url-".repeat(8)}`;
const DOTTED_CIPHERTEXT = `${SYNTHETIC_CIPHERTEXT}.c3ludGhldGljLXJvdXRpbmc`;
const config: OpenClawConfig = { logging: {} };

function reasoningMessage(encryptedContent: unknown, api = "openai-responses") {
  return castAgentMessage({
    role: "assistant",
    provider: "openrouter",
    api,
    model: "test-model",
    content: [
      {
        type: "thinking",
        thinking: "visible",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          summary: [],
          encrypted_content: encryptedContent,
        }),
      },
    ],
  });
}

describe.each(["openai-responses", "openclaw-openai-responses-transport"])(
  "dotted Responses reasoning on %s",
  (api) => {
    it.each(["openai", "openrouter", "litellm", "custom-proxy"])(
      "preserves ciphertext for %s while redacting plaintext and nested lookalikes",
      (provider) => {
        const metadata = {
          v: 1,
          source: "openai-responses",
          provider,
          api,
          model: "test-model",
          baseUrlHash: "0123456789abcdef",
        };
        const item = {
          id: "rs_synthetic",
          type: "reasoning",
          summary: [],
          status: "completed",
          encrypted_content: DOTTED_CIPHERTEXT,
          __openclaw_replay: metadata,
        };
        const signature = JSON.stringify(item);
        const message = castAgentMessage({
          role: "assistant",
          provider,
          api,
          model: "test-model",
          content: [
            {
              type: "thinking",
              thinking: "secret sk-abcdef1234567890xyz",
              thinkingSignature: JSON.stringify({
                ...item,
                summary: [{ type: "summary_text", text: "secret sk-abcdef1234567890xyz" }],
                content: [{ type: "reasoning_text", text: "secret sk-abcdef1234567890xyz" }],
                __openclaw_replay: { ...metadata, secret: "sk-abcdef1234567890xyz" },
              }),
            },
            { type: "text", text: DOTTED_CIPHERTEXT },
            {
              type: "toolCall",
              id: "call_synthetic",
              name: "lookup",
              arguments: { thinkingSignature: signature, encrypted_content: DOTTED_CIPHERTEXT },
            },
          ],
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            provider,
            api,
            model: "test-model",
            baseUrlHash: "0123456789abcdef",
            data: DOTTED_CIPHERTEXT,
          },
        });
        const result = redactTranscriptMessage(message, config);
        expect(result).toHaveProperty("content.0.thinkingSignature", signature);
        expect(result).not.toHaveProperty("providerReplay");
        expect(result).not.toHaveProperty("content.1.text", DOTTED_CIPHERTEXT);
        expect(result).not.toHaveProperty("content.2.arguments.thinkingSignature", signature);
        expect(result).not.toHaveProperty(
          "content.2.arguments.encrypted_content",
          DOTTED_CIPHERTEXT,
        );
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("sk-abcdef1234567890xyz");
        const reloaded = castAgentMessage(JSON.parse(serialized));
        expect(redactTranscriptMessage(reloaded, config)).toHaveProperty(
          "content.0.thinkingSignature",
          signature,
        );
      },
    );

    it("preserves terminal padding on both ciphertext segments", () => {
      const encryptedContent = `${SYNTHETIC_CIPHERTEXT}==.c3ludGhldGljLXJvdXRpbmc=`;
      expect(
        redactTranscriptMessage(reasoningMessage(encryptedContent, api), config),
      ).toHaveProperty(
        "content.0.thinkingSignature",
        JSON.stringify({ type: "reasoning", summary: [], encrypted_content: encryptedContent }),
      );
    });
  },
);

it.each([
  ["empty suffix", `${SYNTHETIC_CIPHERTEXT}.`],
  ["empty ciphertext", `.${SYNTHETIC_CIPHERTEXT}`],
  ["empty middle segment", `${SYNTHETIC_CIPHERTEXT}..suffix`],
  ["extra segment", `${DOTTED_CIPHERTEXT}.extra`],
  ["internal whitespace", `${SYNTHETIC_CIPHERTEXT}.not a token`],
  ["trailing newline", `${DOTTED_CIPHERTEXT}\n`],
  ["nonterminal padding", `${SYNTHETIC_CIPHERTEXT}.suffix=middle`],
  ["excess padding", `${SYNTHETIC_CIPHERTEXT}.suffix===`],
  ["truncation marker", `${DOTTED_CIPHERTEXT}…`],
  ["non-base64url suffix", `${SYNTHETIC_CIPHERTEXT}.suffix/extra`],
])("redacts malformed dotted Responses ciphertext: %s", (_name, encryptedContent) => {
  const result = redactTranscriptMessage(reasoningMessage(encryptedContent), config);
  expect(JSON.stringify(result)).not.toContain(SYNTHETIC_CIPHERTEXT);
});

it.each(["custom-provider-api", "anthropic-messages", "openai-completions"])(
  "keeps dotted payload redaction on %s unchanged",
  (api) => {
    const message = castAgentMessage({
      role: "assistant",
      api,
      provider: "openrouter",
      model: "test-model",
      content: [
        { type: "thinking", thinking: "visible", thinkingSignature: DOTTED_CIPHERTEXT },
        {
          type: "thinking",
          thinking: "visible",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            summary: [],
            encrypted_content: DOTTED_CIPHERTEXT,
          }),
        },
        {
          type: "toolCall",
          id: "call_synthetic",
          name: "lookup",
          arguments: {},
          thoughtSignature: JSON.stringify({
            type: "reasoning.encrypted",
            data: DOTTED_CIPHERTEXT,
          }),
        },
      ],
    });
    const result = redactTranscriptMessage(message, config);
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_CIPHERTEXT);
  },
);

it.each([
  ["unrecognized type", { type: "other" }],
  ["non-array summary", { summary: "visible" }],
  ["invalid status", { status: "future" }],
  ["unsafe identifier", { id: "secret sk-abcdef1234567890xyz" }],
])("keeps malformed dotted reasoning envelopes credential-safe: %s", (_name, override) => {
  const message = castAgentMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "openrouter",
    model: "test-model",
    content: [
      {
        type: "thinking",
        thinking: "visible",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          summary: [],
          encrypted_content: DOTTED_CIPHERTEXT,
          ...override,
        }),
      },
    ],
  });
  const serialized = JSON.stringify(redactTranscriptMessage(message, config));
  expect(serialized).not.toContain(SYNTHETIC_CIPHERTEXT);
  expect(serialized).not.toContain("sk-abcdef1234567890xyz");
});
