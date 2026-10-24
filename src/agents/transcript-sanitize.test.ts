import { expect, it } from "vitest";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { sanitizeTranscriptMessage } from "./transcript-sanitize.js";

const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAARcnVOZAAAAKIDABCDEFGHIJKLMNOP8JJRuAAAAABJRU5ErkJggg==";
const ciphertext =
  "gAAAAABpQnQrXzzZqcAfo3unbAY-ku84xgsvB0fpLkbDvSh3WS5qzfSCmcgwr8_abcdefghijvK2RyV2GQ4ohzcfYwhRwTvY76TvR7Tvr_";
const route = { provider: "openai", api: "openai-responses", model: "test-model" };
const anthropicRoute = { provider: "anthropic", api: "anthropic-messages" };
const replay = {
  ...route,
  v: 1,
  type: "openai-responses-retained-compaction",
  id: "cmp_1",
  data: ciphertext,
  baseUrlHash: "ozhevd1smnk8s",
};

const sanitize = (message: unknown) => sanitizeTranscriptMessage(castAgentMessage(message));
function sanitizeAssistant(content: unknown[], overrides: Record<string, unknown> = {}) {
  return sanitize({ role: "assistant", ...route, content, ...overrides });
}
function sanitizeReplay(overrides: Record<string, unknown>) {
  return sanitizeAssistant([], { providerReplay: { ...replay, ...overrides } });
}
function expectReplay(overrides: Record<string, unknown>, expected: Record<string, unknown>) {
  const result = sanitizeReplay(structuredClone(overrides));
  expect(result).toHaveProperty("providerReplay", { ...replay, ...expected });
}
const text = (value: string) => ({ type: "text", text: value });
const compaction = { type: "compaction", id: "cmp_1", encrypted_content: ciphertext };
const toolCall = (command = "API_TOKEN=sk-abcdef1234567890xyz") => ({
  type: "toolCall",
  id: "call_1",
  name: "exec",
  arguments: { command },
});
function compactedWindow(content: unknown) {
  const message = { type: "message", role: "user", content: [content] };
  return { state: "ready", output: JSON.stringify([message, compaction], null, 2) };
}

it("preserves secret-shaped text, tool arguments, details, and sender metadata", () => {
  const source = "API_TOKEN = computeToken()\nAPI_KEY=sk-abcdef1234567890xyz";
  const messages = [
    { role: "user", content: source, __openclaw: { senderId: "person", humanMentions: [] } },
    { role: "assistant", content: [text(source), toolCall(source)] },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [text(source)],
      details: { apiKey: "plainsecretvalue123", password: "hunter2" },
    },
  ];
  for (const message of messages) {
    expect(sanitize(message)).toBe(message);
  }
});

it("normalizes circular result structures without masking their string fields", () => {
  const details: Record<string, unknown> = { apiKey: "plainsecretvalue123" };
  details.self = details;
  expect(sanitize({ role: "toolResult", content: [], details })).toHaveProperty("details", {
    apiKey: "plainsecretvalue123",
    self: "[Circular]",
  });
  expect(details.self).toBe(details);
});

it("canonicalizes inline image MIME and data URLs while preserving adjacent text", () => {
  const content = [
    text("sk-abcdef1234567890xyz"),
    { type: "image", data: image, mimeType: "image/jpeg" },
    { type: "image_url", image_url: { url: `data:image/png;charset=utf-8;base64,${image}` } },
  ];
  expect(sanitize({ role: "toolResult", content })).toHaveProperty("content", [
    text("sk-abcdef1234567890xyz"),
    { type: "image", data: image, mimeType: "image/png" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
  ]);
});

it.each([
  { content: undefined },
  { content: [] },
  { content: [{ type: "reasoning_text", text: "not part of replay" }] },
])("canonicalizes Responses reasoning and retains empty containers: %j", ({ content }) => {
  const result = sanitizeAssistant([
    {
      type: "thinking",
      thinking: "",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "not part of replay" }],
        content,
        encrypted_content: ciphertext,
        status: "completed",
        extra: "not part of replay",
      }),
    },
  ]);
  const emptyContent = content?.length === 0 ? ',"content":[]' : "";
  expect(result).toHaveProperty(
    "content.0.thinkingSignature",
    `{"id":"rs_1","type":"reasoning","summary":[]${emptyContent},` +
      `"status":"completed","encrypted_content":"${ciphertext}"}`,
  );
});

it("canonicalizes OpenAI-compatible tool reasoning without changing arguments", () => {
  const signature = { type: "reasoning.encrypted", data: ciphertext, format: null };
  const result = sanitizeAssistant(
    [
      {
        ...toolCall(),
        thoughtSignature: JSON.stringify({ ...signature, extra: "discarded" }),
      },
    ],
    { api: "openai-completions" },
  );
  expect(result).toHaveProperty("content.0", {
    ...toolCall(),
    thoughtSignature: JSON.stringify(signature),
  });
});

it.each([
  { provider: "other-provider" },
  { baseUrlHash: "not a valid hash" },
  { replayIndex: -1 },
  { data: "not an opaque token" },
])("rejects a malformed or foreign compaction checkpoint: %j", (override) => {
  expect(sanitizeReplay(override)).not.toHaveProperty("providerReplay");
});

it("preserves exact canonical retained windows including secret-shaped source text", () => {
  const window = compactedWindow({ type: "input_text", text: "API_KEY=sk-abcdef1234567890xyz" });
  expectReplay({ compactedWindow: window, extra: "discarded" }, { compactedWindow: window });
});

it.each([
  { type: "input_image", image_url: `data:image/jpeg;base64,${image}` },
  { type: "input_text", text: 42 },
])("retains the newest barrier when its stored window needs refreshing: %j", (content) => {
  expectReplay(
    { compactedWindow: compactedWindow(content) },
    { compactedWindow: { state: "refresh-required" } },
  );
});

it("preserves Anthropic compaction summaries and validates the attached route", () => {
  const providerReplay = {
    ...replay,
    type: "anthropic-compaction",
    ...anthropicRoute,
    data: "summary containing sk-abcdef1234567890xyz",
    encryptedContent: ciphertext,
    replayIndex: 0,
  };
  const { id: _id, ...expected } = providerReplay;
  const result = sanitizeAssistant([], { providerReplay, ...anthropicRoute });
  expect(result).toHaveProperty("providerReplay", expected);
});
