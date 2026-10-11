import { describe, expect, it } from "vitest";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { sanitizeTranscriptMessage } from "./transcript-sanitize.js";

const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAARcnVOZAAAAKIDABCDEFGHIJKLMNOP8JJRuAAAAABJRU5ErkJggg==";
const ciphertext =
  "gAAAAABpQnQrXzzZqcAfo3unbAY-ku84xgsvB0fpLkbDvSh3WS5qzfSCmcgwr8_abcdefghijvK2RyV2GQ4ohzcfYwhRwTvY76TvR7Tvr_";
const route = {
  provider: "openai",
  api: "openai-responses",
  model: "test-model",
};
const replay = {
  ...route,
  v: 1,
  type: "openai-responses-retained-compaction",
  id: "cmp_1",
  data: ciphertext,
  baseUrlHash: "ozhevd1smnk8s",
};

function messageWithReplay(providerReplay: unknown) {
  return castAgentMessage({ role: "assistant", ...route, content: [], providerReplay });
}

describe("transcript normalization", () => {
  it("preserves secret-shaped text, tool arguments, details, and sender metadata", () => {
    const source = "API_TOKEN = computeToken()\nAPI_KEY=sk-abcdef1234567890xyz";
    const messages = [
      { role: "user", content: source, __openclaw: { senderId: "person", humanMentions: [] } },
      {
        role: "assistant",
        content: [
          { type: "text", text: source },
          { type: "toolCall", id: "call_1", name: "exec", arguments: { command: source } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: source }],
        details: { apiKey: "plainsecretvalue123", password: "hunter2" },
      },
    ];
    for (const message of messages) {
      expect(sanitizeTranscriptMessage(castAgentMessage(message))).toBe(message);
    }
  });

  it("normalizes circular result structures without masking their string fields", () => {
    const details: Record<string, unknown> = { apiKey: "plainsecretvalue123" };
    details.self = details;
    const message = castAgentMessage({ role: "toolResult", content: [], details });
    expect(sanitizeTranscriptMessage(message)).toHaveProperty("details", {
      apiKey: "plainsecretvalue123",
      self: "[Circular]",
    });
    expect(details.self).toBe(details);
  });

  it("canonicalizes inline image MIME and data URLs while preserving adjacent text", () => {
    const message = castAgentMessage({
      role: "toolResult",
      content: [
        { type: "text", text: "sk-abcdef1234567890xyz" },
        { type: "image", data: image, mimeType: "image/jpeg" },
        { type: "image_url", image_url: { url: `data:image/png;charset=utf-8;base64,${image}` } },
      ],
    });
    expect(sanitizeTranscriptMessage(message)).toHaveProperty("content", [
      { type: "text", text: "sk-abcdef1234567890xyz" },
      { type: "image", data: image, mimeType: "image/png" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
    ]);
  });

  it("canonicalizes Responses reasoning and retains credential-shaped encrypted bytes", () => {
    const message = castAgentMessage({
      role: "assistant",
      ...route,
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "not part of replay" }],
            encrypted_content: ciphertext,
            status: "completed",
            extra: "not part of replay",
          }),
        },
      ],
    });
    expect(sanitizeTranscriptMessage(message)).toHaveProperty(
      "content.0.thinkingSignature",
      JSON.stringify({
        id: "rs_1",
        type: "reasoning",
        summary: [],
        status: "completed",
        encrypted_content: ciphertext,
      }),
    );
  });

  it("canonicalizes OpenAI-compatible tool reasoning without changing arguments", () => {
    const message = castAgentMessage({
      role: "assistant",
      ...route,
      api: "openai-completions",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "exec",
          arguments: { command: "API_TOKEN=sk-abcdef1234567890xyz" },
          thoughtSignature: JSON.stringify({
            type: "reasoning.encrypted",
            data: ciphertext,
            format: null,
            extra: "discarded",
          }),
        },
      ],
    });
    expect(sanitizeTranscriptMessage(message)).toHaveProperty("content.0", {
      type: "toolCall",
      id: "call_1",
      name: "exec",
      arguments: { command: "API_TOKEN=sk-abcdef1234567890xyz" },
      thoughtSignature: JSON.stringify({
        type: "reasoning.encrypted",
        data: ciphertext,
        format: null,
      }),
    });
  });

  it.each([
    { provider: "other-provider" },
    { baseUrlHash: "not a valid hash" },
    { replayIndex: -1 },
    { data: "not an opaque token" },
  ])("rejects a malformed or foreign compaction checkpoint: %j", (override) => {
    expect(
      sanitizeTranscriptMessage(messageWithReplay({ ...replay, ...override })),
    ).not.toHaveProperty("providerReplay");
  });

  it("preserves exact canonical retained windows including secret-shaped source text", () => {
    const output = JSON.stringify(
      [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "API_KEY=sk-abcdef1234567890xyz" }],
        },
        { type: "compaction", id: "cmp_1", encrypted_content: ciphertext },
      ],
      null,
      2,
    );
    const message = messageWithReplay({
      ...replay,
      compactedWindow: { state: "ready", output },
      extra: "discarded",
    });
    expect(sanitizeTranscriptMessage(message)).toHaveProperty("providerReplay", {
      ...replay,
      compactedWindow: { state: "ready", output },
    });
  });

  it.each([
    { type: "input_image", image_url: `data:image/jpeg;base64,${image}` },
    { type: "input_text", text: 42 },
  ])("retains the newest barrier when its stored window needs refreshing: %j", (content) => {
    const message = messageWithReplay({
      ...replay,
      compactedWindow: {
        state: "ready",
        output: JSON.stringify([
          { type: "message", role: "user", content: [content] },
          { type: "compaction", id: "cmp_1", encrypted_content: ciphertext },
        ]),
      },
    });
    expect(sanitizeTranscriptMessage(message)).toHaveProperty("providerReplay", {
      ...replay,
      compactedWindow: { state: "refresh-required" },
    });
  });

  it("preserves Anthropic compaction summaries and validates the attached route", () => {
    const providerReplay = {
      ...replay,
      type: "anthropic-compaction",
      provider: "anthropic",
      api: "anthropic-messages",
      data: "summary containing sk-abcdef1234567890xyz",
      encryptedContent: ciphertext,
      replayIndex: 0,
    };
    const message = castAgentMessage({
      role: "assistant",
      ...route,
      provider: "anthropic",
      api: "anthropic-messages",
      content: [],
      providerReplay,
    });
    const { id: _id, ...expected } = providerReplay;
    expect(sanitizeTranscriptMessage(message)).toHaveProperty("providerReplay", expected);
  });
});
