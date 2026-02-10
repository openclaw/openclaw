import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendMessageToTranscript,
  ensureTranscriptFile,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readSessionMessages,
  readSessionPreviewItemsFromTranscript,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";

describe("readFirstUserMessageFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-fs-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when transcript file does not exist", () => {
    const result = readFirstUserMessageFromTranscript("nonexistent-session", storePath);
    expect(result).toBeNull();
  });

  test("returns first user message from transcript with string content", () => {
    const sessionId = "test-session-1";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "Hello world" } }),
      JSON.stringify({ message: { role: "assistant", content: "Hi there" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Hello world");
  });

  test("returns first user message from transcript with array content", () => {
    const sessionId = "test-session-2";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "Array message content" }],
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Array message content");
  });

  test("returns first user message from transcript with input_text content", () => {
    const sessionId = "test-session-2b";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "input_text", text: "Input text content" }],
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Input text content");
  });
  test("skips non-user messages to find first user message", () => {
    const sessionId = "test-session-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "System prompt" } }),
      JSON.stringify({ message: { role: "assistant", content: "Greeting" } }),
      JSON.stringify({ message: { role: "user", content: "First user question" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("First user question");
  });

  test("returns null when no user messages exist", () => {
    const sessionId = "test-session-4";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "System prompt" } }),
      JSON.stringify({ message: { role: "assistant", content: "Greeting" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test("handles malformed JSON lines gracefully", () => {
    const sessionId = "test-session-5";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      "not valid json",
      JSON.stringify({ message: { role: "user", content: "Valid message" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid message");
  });

  test("uses sessionFile parameter when provided", () => {
    const sessionId = "test-session-6";
    const customPath = path.join(tmpDir, "custom-transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "Custom file message" } }),
    ];
    fs.writeFileSync(customPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath, customPath);
    expect(result).toBe("Custom file message");
  });

  test("trims whitespace from message content", () => {
    const sessionId = "test-session-7";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [JSON.stringify({ message: { role: "user", content: "  Padded message  " } })];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Padded message");
  });

  test("returns null for empty content", () => {
    const sessionId = "test-session-8";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "" } }),
      JSON.stringify({ message: { role: "user", content: "Second message" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Second message");
  });
});

describe("readLastMessagePreviewFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-fs-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when transcript file does not exist", () => {
    const result = readLastMessagePreviewFromTranscript("nonexistent-session", storePath);
    expect(result).toBeNull();
  });

  test("returns null for empty file", () => {
    const sessionId = "test-last-empty";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test("returns last user message from transcript", () => {
    const sessionId = "test-last-user";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "First user" } }),
      JSON.stringify({ message: { role: "assistant", content: "First assistant" } }),
      JSON.stringify({ message: { role: "user", content: "Last user message" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Last user message");
  });

  test("returns last assistant message from transcript", () => {
    const sessionId = "test-last-assistant";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "User question" } }),
      JSON.stringify({ message: { role: "assistant", content: "Final assistant reply" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Final assistant reply");
  });

  test("skips system messages to find last user/assistant", () => {
    const sessionId = "test-last-skip-system";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "Real last" } }),
      JSON.stringify({ message: { role: "system", content: "System at end" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Real last");
  });

  test("returns null when no user/assistant messages exist", () => {
    const sessionId = "test-last-no-match";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "Only system" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test("handles malformed JSON lines gracefully", () => {
    const sessionId = "test-last-malformed";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "Valid first" } }),
      "not valid json at end",
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid first");
  });

  test("handles array content format", () => {
    const sessionId = "test-last-array";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Array content response" }],
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Array content response");
  });

  test("handles output_text content format", () => {
    const sessionId = "test-last-output-text";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "output_text", text: "Output text response" }],
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Output text response");
  });
  test("uses sessionFile parameter when provided", () => {
    const sessionId = "test-last-custom";
    const customPath = path.join(tmpDir, "custom-last.jsonl");
    const lines = [JSON.stringify({ message: { role: "user", content: "Custom file last" } })];
    fs.writeFileSync(customPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath, customPath);
    expect(result).toBe("Custom file last");
  });

  test("trims whitespace from message content", () => {
    const sessionId = "test-last-trim";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "  Padded response  " } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Padded response");
  });

  test("skips empty content to find previous message", () => {
    const sessionId = "test-last-skip-empty";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "Has content" } }),
      JSON.stringify({ message: { role: "user", content: "" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Has content");
  });

  test("reads from end of large file (16KB window)", () => {
    const sessionId = "test-last-large";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const padding = JSON.stringify({ message: { role: "user", content: "x".repeat(500) } });
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(padding);
    }
    lines.push(JSON.stringify({ message: { role: "assistant", content: "Last in large file" } }));
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Last in large file");
  });

  test("handles valid UTF-8 content", () => {
    const sessionId = "test-last-utf8";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const validLine = JSON.stringify({
      message: { role: "user", content: "Valid UTF-8: 你好世界 🌍" },
    });
    fs.writeFileSync(transcriptPath, validLine, "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid UTF-8: 你好世界 🌍");
  });
});

describe("readSessionMessages", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-fs-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("includes synthetic compaction markers for compaction entries", () => {
    const sessionId = "test-session-compaction";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify({
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "Compacted history",
        firstKeptEntryId: "x",
        tokensBefore: 123,
      }),
      JSON.stringify({ message: { role: "assistant", content: "World" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath);
    expect(out).toHaveLength(3);
    const marker = out[1] as {
      role: string;
      content?: Array<{ text?: string }>;
      __openclaw?: { kind?: string; id?: string };
      timestamp?: number;
    };
    expect(marker.role).toBe("system");
    expect(marker.content?.[0]?.text).toBe("Compaction");
    expect(marker.__openclaw?.kind).toBe("compaction");
    expect(marker.__openclaw?.id).toBe("comp-1");
    expect(typeof marker.timestamp).toBe("number");
  });
});

describe("readSessionPreviewItemsFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-preview-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns recent preview items with tool summary", () => {
    const sessionId = "preview-session";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify({ message: { role: "assistant", content: "Hi" } }),
      JSON.stringify({
        message: { role: "assistant", content: [{ type: "toolcall", name: "weather" }] },
      }),
      JSON.stringify({ message: { role: "assistant", content: "Forecast ready" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readSessionPreviewItemsFromTranscript(
      sessionId,
      storePath,
      undefined,
      undefined,
      3,
      120,
    );

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call weather");
  });

  test("detects tool calls from tool_use/tool_call blocks and toolName field", () => {
    const sessionId = "preview-session-tools";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "assistant", content: "Hi" } }),
      JSON.stringify({
        message: {
          role: "assistant",
          toolName: "camera",
          content: [
            { type: "tool_use", name: "read" },
            { type: "tool_call", name: "write" },
          ],
        },
      }),
      JSON.stringify({ message: { role: "assistant", content: "Done" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readSessionPreviewItemsFromTranscript(
      sessionId,
      storePath,
      undefined,
      undefined,
      3,
      120,
    );

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call");
    expect(result[1]?.text).toContain("camera");
    expect(result[1]?.text).toContain("read");
    // Preview text may not list every tool name; it should at least hint there were multiple calls.
    expect(result[1]?.text).toMatch(/\+\d+/);
  });

  test("truncates preview text to max chars", () => {
    const sessionId = "preview-truncate";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const longText = "a".repeat(60);
    const lines = [JSON.stringify({ message: { role: "assistant", content: longText } })];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readSessionPreviewItemsFromTranscript(
      sessionId,
      storePath,
      undefined,
      undefined,
      1,
      24,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.text.length).toBe(24);
    expect(result[0]?.text.endsWith("...")).toBe(true);
  });
});

describe("appendMessageToTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-append-msg-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("appends user message to existing transcript", () => {
    const sessionId = "test-append-user";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId });
    fs.writeFileSync(transcriptPath, header + "\n", "utf-8");

    const result = appendMessageToTranscript({
      message: "Hello from user",
      role: "user",
      sessionId,
      storePath,
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBeDefined();

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const msg = JSON.parse(lines[1]);
    expect(msg.message.role).toBe("user");
    expect(msg.message.content[0].text).toBe("Hello from user");
    expect(msg.message.stopReason).toBeUndefined();
  });

  test("appends assistant message with stopReason", () => {
    const sessionId = "test-append-assistant";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId });
    fs.writeFileSync(transcriptPath, header + "\n", "utf-8");

    const result = appendMessageToTranscript({
      message: "Hello from assistant",
      role: "assistant",
      sessionId,
      storePath,
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    const msg = JSON.parse(lines[1]);
    expect(msg.message.role).toBe("assistant");
    expect(msg.message.stopReason).toBe("cli_backend");
    expect(msg.message.usage).toBeDefined();
  });

  test("creates transcript file when createIfMissing is true", () => {
    const sessionId = "test-append-create";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    expect(fs.existsSync(transcriptPath)).toBe(false);

    const result = appendMessageToTranscript({
      message: "First message",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: true,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");
    expect(header.id).toBe(sessionId);
  });

  test("fails when transcript does not exist and createIfMissing is false", () => {
    const sessionId = "test-append-no-create";

    const result = appendMessageToTranscript({
      message: "Message",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("prefers sessionFile over storePath", () => {
    const sessionId = "test-append-sessionfile";
    const customPath = path.join(tmpDir, "custom-transcript.jsonl");
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId });
    fs.writeFileSync(customPath, header + "\n", "utf-8");

    const result = appendMessageToTranscript({
      message: "Custom file message",
      role: "user",
      sessionId,
      sessionFile: customPath,
      storePath,
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(customPath, "utf-8");
    expect(content).toContain("Custom file message");
  });

  test("includes provider and model in assistant message metadata", () => {
    const sessionId = "test-append-metadata";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId });
    fs.writeFileSync(transcriptPath, header + "\n", "utf-8");

    const result = appendMessageToTranscript({
      message: "Response with metadata",
      role: "assistant",
      sessionId,
      storePath,
      provider: "claude-cli",
      model: "claude-3-opus",
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    const msg = JSON.parse(lines[1]);
    expect(msg.message.provider).toBe("claude-cli");
    expect(msg.message.model).toBe("claude-3-opus");
  });

  test("omits provider/model when not provided", () => {
    const sessionId = "test-append-no-metadata";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId });
    fs.writeFileSync(transcriptPath, header + "\n", "utf-8");

    const result = appendMessageToTranscript({
      message: "Response without metadata",
      role: "assistant",
      sessionId,
      storePath,
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    const msg = JSON.parse(lines[1]);
    expect(msg.message.provider).toBeUndefined();
    expect(msg.message.model).toBeUndefined();
  });

  test("includes usage data when provided for assistant message", () => {
    const sessionId = "test-append-usage";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId });
    fs.writeFileSync(transcriptPath, header + "\n", "utf-8");

    const result = appendMessageToTranscript({
      message: "Response with usage",
      role: "assistant",
      sessionId,
      storePath,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        total: 165,
      },
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    const msg = JSON.parse(lines[1]);
    expect(msg.message.usage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
    });
  });

  test("defaults usage to zeros when not provided for assistant message", () => {
    const sessionId = "test-append-no-usage";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId });
    fs.writeFileSync(transcriptPath, header + "\n", "utf-8");

    const result = appendMessageToTranscript({
      message: "Response without usage",
      role: "assistant",
      sessionId,
      storePath,
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    const msg = JSON.parse(lines[1]);
    expect(msg.message.usage.input).toBe(0);
    expect(msg.message.usage.output).toBe(0);
    expect(msg.message.usage.totalTokens).toBe(0);
  });
});

describe("ensureTranscriptFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-ensure-transcript-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates transcript file with valid header", () => {
    const sessionId = "test-ensure-create";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    const result = ensureTranscriptFile({ transcriptPath, sessionId });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const header = JSON.parse(content.trim());
    expect(header.type).toBe("session");
    expect(header.id).toBe(sessionId);
    expect(header.timestamp).toBeDefined();
  });

  test("returns ok when file already exists", () => {
    const sessionId = "test-ensure-exists";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, "existing content\n", "utf-8");

    const result = ensureTranscriptFile({ transcriptPath, sessionId });

    expect(result.ok).toBe(true);
    // Content should not be modified
    const content = fs.readFileSync(transcriptPath, "utf-8");
    expect(content).toBe("existing content\n");
  });

  test("creates nested directories if needed", () => {
    const sessionId = "test-ensure-nested";
    const transcriptPath = path.join(tmpDir, "nested", "deeply", `${sessionId}.jsonl`);

    const result = ensureTranscriptFile({ transcriptPath, sessionId });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(transcriptPath)).toBe(true);
  });

  test("returns error for invalid path", () => {
    const sessionId = "test-ensure-invalid";
    // Path that cannot be created (null byte in path)
    const transcriptPath = "/dev/null/\0/invalid.jsonl";

    const result = ensureTranscriptFile({ transcriptPath, sessionId });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("resolveSessionTranscriptCandidates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("fallback candidate uses OPENCLAW_HOME instead of os.homedir()", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const candidates = resolveSessionTranscriptCandidates("sess-1", undefined);
    const fallback = candidates[candidates.length - 1];
    expect(fallback).toBe(
      path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "sessions", "sess-1.jsonl"),
    );
  });
});
