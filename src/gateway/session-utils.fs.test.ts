import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import {
  archiveSessionTranscripts,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readSessionMessages,
  readSessionTitleFieldsFromTranscript,
  readSessionPreviewItemsFromTranscript,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";

function registerTempSessionStore(
  prefix: string,
  assignPaths: (tmpDir: string, storePath: string) => void,
) {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    assignPaths(dir, path.join(dir, "sessions.json"));
  });
  afterAll(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function writeTranscript(tmpDir: string, sessionId: string, lines: unknown[]): string {
  const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
  return transcriptPath;
}

function buildBasicSessionTranscript(
  sessionId: string,
  userText = "Hello world",
  assistantText = "Hi there",
): unknown[] {
  return [
    { type: "session", version: 1, id: sessionId },
    { message: { role: "user", content: userText } },
    { message: { role: "assistant", content: assistantText } },
  ];
}

describe("readFirstUserMessageFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("extracts first user text across supported content formats", () => {
    const cases = [
      {
        sessionId: "test-session-1",
        lines: [
          JSON.stringify({ type: "session", version: 1, id: "test-session-1" }),
          JSON.stringify({ message: { role: "user", content: "Hello world" } }),
          JSON.stringify({ message: { role: "assistant", content: "Hi there" } }),
        ],
        expected: "Hello world",
      },
      {
        sessionId: "test-session-2",
        lines: [
          JSON.stringify({ type: "session", version: 1, id: "test-session-2" }),
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: "Array message content" }],
            },
          }),
        ],
        expected: "Array message content",
      },
      {
        sessionId: "test-session-2b",
        lines: [
          JSON.stringify({ type: "session", version: 1, id: "test-session-2b" }),
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "input_text", text: "Input text content" }],
            },
          }),
        ],
        expected: "Input text content",
      },
    ] as const;

    for (const testCase of cases) {
      const transcriptPath = path.join(tmpDir, `${testCase.sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, testCase.lines.join("\n"), "utf-8");
      const result = readFirstUserMessageFromTranscript(testCase.sessionId, storePath);
      expect(result, testCase.sessionId).toBe(testCase.expected);
    }
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

  test("skips inter-session user messages by default", () => {
    const sessionId = "test-session-inter-session";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        message: {
          role: "user",
          content: "Forwarded by session tool",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      }),
      JSON.stringify({
        message: { role: "user", content: "Real user message" },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Real user message");
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

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns null for empty file", () => {
    const sessionId = "test-last-empty";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test("returns the last user or assistant message from transcript", () => {
    const cases = [
      {
        sessionId: "test-last-user",
        lines: [
          JSON.stringify({ message: { role: "user", content: "First user" } }),
          JSON.stringify({ message: { role: "assistant", content: "First assistant" } }),
          JSON.stringify({ message: { role: "user", content: "Last user message" } }),
        ],
        expected: "Last user message",
      },
      {
        sessionId: "test-last-assistant",
        lines: [
          JSON.stringify({ message: { role: "user", content: "User question" } }),
          JSON.stringify({ message: { role: "assistant", content: "Final assistant reply" } }),
        ],
        expected: "Final assistant reply",
      },
    ] as const;

    for (const testCase of cases) {
      const transcriptPath = path.join(tmpDir, `${testCase.sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, testCase.lines.join("\n"), "utf-8");
      const result = readLastMessagePreviewFromTranscript(testCase.sessionId, storePath);
      expect(result).toBe(testCase.expected);
    }
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

  test("handles malformed JSON lines gracefully (last preview)", () => {
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

  test("handles array/output_text content formats", () => {
    const cases = [
      {
        sessionId: "test-last-array",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Array content response" }],
        },
        expected: "Array content response",
      },
      {
        sessionId: "test-last-output-text",
        message: {
          role: "assistant",
          content: [{ type: "output_text", text: "Output text response" }],
        },
        expected: "Output text response",
      },
    ] as const;
    for (const testCase of cases) {
      const transcriptPath = path.join(tmpDir, `${testCase.sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, JSON.stringify({ message: testCase.message }), "utf-8");
      const result = readLastMessagePreviewFromTranscript(testCase.sessionId, storePath);
      expect(result, testCase.sessionId).toBe(testCase.expected);
    }
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
    for (let i = 0; i < 30; i++) {
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

  test("strips inline directives from last preview text", () => {
    const sessionId = "test-last-strip-inline-directives";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "Hello [[reply_to_current]] world [[audio_as_voice]]",
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Hello  world");
  });
});

describe("shared transcript read behaviors", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns null for missing transcript files", () => {
    expect(readFirstUserMessageFromTranscript("missing-session", storePath)).toBeNull();
    expect(readLastMessagePreviewFromTranscript("missing-session", storePath)).toBeNull();
  });

  test("uses sessionFile overrides when provided", () => {
    const sessionId = "test-shared-custom";
    const firstPath = path.join(tmpDir, "custom-first.jsonl");
    const lastPath = path.join(tmpDir, "custom-last.jsonl");

    fs.writeFileSync(
      firstPath,
      [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify({ message: { role: "user", content: "Custom file message" } }),
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      lastPath,
      JSON.stringify({ message: { role: "assistant", content: "Custom file last" } }),
      "utf-8",
    );

    expect(readFirstUserMessageFromTranscript(sessionId, storePath, firstPath)).toBe(
      "Custom file message",
    );
    expect(readLastMessagePreviewFromTranscript(sessionId, storePath, lastPath)).toBe(
      "Custom file last",
    );
  });

  test("trims whitespace in extracted previews", () => {
    const firstSessionId = "test-shared-first-trim";
    const lastSessionId = "test-shared-last-trim";

    fs.writeFileSync(
      path.join(tmpDir, `${firstSessionId}.jsonl`),
      JSON.stringify({ message: { role: "user", content: "  Padded message  " } }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, `${lastSessionId}.jsonl`),
      JSON.stringify({ message: { role: "assistant", content: "  Padded response  " } }),
      "utf-8",
    );

    expect(readFirstUserMessageFromTranscript(firstSessionId, storePath)).toBe("Padded message");
    expect(readLastMessagePreviewFromTranscript(lastSessionId, storePath)).toBe("Padded response");
  });
});

describe("readSessionTitleFieldsFromTranscript cache", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns cached values without re-reading when unchanged", () => {
    const sessionId = "test-cache-1";
    writeTranscript(tmpDir, sessionId, buildBasicSessionTranscript(sessionId));

    const readSpy = vi.spyOn(fs, "readSync");

    const first = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    const readsAfterFirst = readSpy.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    expect(second).toEqual(first);
    expect(readSpy.mock.calls.length).toBe(readsAfterFirst);
    readSpy.mockRestore();
  });

  test("invalidates cache when transcript changes", () => {
    const sessionId = "test-cache-2";
    const transcriptPath = writeTranscript(
      tmpDir,
      sessionId,
      buildBasicSessionTranscript(sessionId, "First", "Old"),
    );

    const readSpy = vi.spyOn(fs, "readSync");

    const first = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    const readsAfterFirst = readSpy.mock.calls.length;
    expect(first.lastMessagePreview).toBe("Old");

    fs.appendFileSync(
      transcriptPath,
      `\n${JSON.stringify({ message: { role: "assistant", content: "New" } })}`,
      "utf-8",
    );

    const second = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    expect(second.lastMessagePreview).toBe("New");
    expect(readSpy.mock.calls.length).toBeGreaterThan(readsAfterFirst);
    readSpy.mockRestore();
  });
});

describe("readSessionMessages", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
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

  test("reads cross-agent absolute sessionFile across store-root layouts", () => {
    const cases = [
      {
        sessionId: "cross-agent-default-root",
        sessionFile: path.join(
          tmpDir,
          "agents",
          "ops",
          "sessions",
          "cross-agent-default-root.jsonl",
        ),
        wrongStorePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
        message: { role: "user", content: "from-ops" },
      },
      {
        sessionId: "cross-agent-custom-root",
        sessionFile: path.join(
          tmpDir,
          "custom",
          "agents",
          "ops",
          "sessions",
          "cross-agent-custom-root.jsonl",
        ),
        wrongStorePath: path.join(tmpDir, "custom", "agents", "main", "sessions", "sessions.json"),
        message: { role: "assistant", content: "from-custom-ops" },
      },
    ] as const;

    for (const testCase of cases) {
      fs.mkdirSync(path.dirname(testCase.sessionFile), { recursive: true });
      fs.writeFileSync(
        testCase.sessionFile,
        [
          JSON.stringify({ type: "session", version: 1, id: testCase.sessionId }),
          JSON.stringify({ message: testCase.message }),
        ].join("\n"),
        "utf-8",
      );

      const out = readSessionMessages(
        testCase.sessionId,
        testCase.wrongStorePath,
        testCase.sessionFile,
      );
      expect(out).toEqual([testCase.message]);
    }
  });
});

describe("readSessionPreviewItemsFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-preview-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  function writeTranscriptLines(sessionId: string, lines: string[]) {
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
  }

  function readPreview(sessionId: string, maxItems = 3, maxChars = 120) {
    return readSessionPreviewItemsFromTranscript(
      sessionId,
      storePath,
      undefined,
      undefined,
      maxItems,
      maxChars,
    );
  }

  test("returns recent preview items with tool summary", () => {
    const sessionId = "preview-session";
    const lines = createToolSummaryPreviewTranscriptLines(sessionId);
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId);

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call weather");
  });

  test("detects tool calls from tool_use/tool_call blocks and toolName field", () => {
    const sessionId = "preview-session-tools";
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
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId);

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call");
    expect(result[1]?.text).toContain("camera");
    expect(result[1]?.text).toContain("read");
    // Preview text may not list every tool name; it should at least hint there were multiple calls.
    expect(result[1]?.text).toMatch(/\+\d+/);
  });

  test("truncates preview text to max chars", () => {
    const sessionId = "preview-truncate";
    const longText = "a".repeat(60);
    const lines = [JSON.stringify({ message: { role: "assistant", content: longText } })];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 24);

    expect(result).toHaveLength(1);
    expect(result[0]?.text.length).toBe(24);
    expect(result[0]?.text.endsWith("...")).toBe(true);
  });

  test("strips inline directives from preview items", () => {
    const sessionId = "preview-strip-inline-directives";
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "A [[reply_to:abc-123]] B [[audio_as_voice]]",
        },
      }),
    ];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 120);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("A  B");
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

describe("resolveSessionTranscriptCandidates safety", () => {
  test("keeps cross-agent absolute sessionFile for standard and custom store roots", () => {
    const cases = [
      {
        storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
        sessionFile: "/tmp/openclaw/agents/ops/sessions/sess-safe.jsonl",
      },
      {
        storePath: "/srv/custom/agents/main/sessions/sessions.json",
        sessionFile: "/srv/custom/agents/ops/sessions/sess-safe.jsonl",
      },
    ] as const;

    for (const testCase of cases) {
      const candidates = resolveSessionTranscriptCandidates(
        "sess-safe",
        testCase.storePath,
        testCase.sessionFile,
      );
      expect(candidates.map((value) => path.resolve(value))).toContain(
        path.resolve(testCase.sessionFile),
      );
    }
  });

  test("drops unsafe session IDs instead of producing traversal paths", () => {
    const candidates = resolveSessionTranscriptCandidates(
      "../etc/passwd",
      "/tmp/openclaw/agents/main/sessions/sessions.json",
    );

    expect(candidates).toEqual([]);
  });

  test("drops unsafe sessionFile candidates and keeps safe fallbacks", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const candidates = resolveSessionTranscriptCandidates(
      "sess-safe",
      storePath,
      "../../etc/passwd",
    );
    const normalizedCandidates = candidates.map((value) => path.resolve(value));
    const expectedFallback = path.resolve(path.dirname(storePath), "sess-safe.jsonl");

    expect(candidates.some((value) => value.includes("etc/passwd"))).toBe(false);
    expect(normalizedCandidates).toContain(expectedFallback);
  });
});

describe("archiveSessionTranscripts", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-archive-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  beforeAll(() => {
    vi.stubEnv("OPENCLAW_HOME", tmpDir);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test("archives transcript from default and explicit sessionFile paths", () => {
    const cases = [
      {
        sessionId: "sess-archive-1",
        transcriptPath: path.join(tmpDir, "sess-archive-1.jsonl"),
        args: { sessionId: "sess-archive-1", storePath, reason: "reset" as const },
      },
      {
        sessionId: "sess-archive-2",
        transcriptPath: path.join(tmpDir, "custom-transcript.jsonl"),
        args: {
          sessionId: "sess-archive-2",
          storePath: undefined,
          sessionFile: path.join(tmpDir, "custom-transcript.jsonl"),
          reason: "reset" as const,
        },
      },
    ] as const;

    for (const testCase of cases) {
      fs.writeFileSync(testCase.transcriptPath, '{"type":"session"}\n', "utf-8");
      const archived = archiveSessionTranscripts(testCase.args);
      expect(archived).toHaveLength(1);
      expect(archived[0]).toContain(".reset.");
      expect(fs.existsSync(testCase.transcriptPath)).toBe(false);
      expect(fs.existsSync(archived[0])).toBe(true);
    }
  });

  test("returns empty array when no transcript files exist", () => {
    const archived = archiveSessionTranscripts({
      sessionId: "nonexistent-session",
      storePath,
      reason: "reset",
    });

    expect(archived).toEqual([]);
  });

  test("skips files that do not exist and archives only existing ones", () => {
    const sessionId = "sess-archive-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, '{"type":"session"}\n', "utf-8");

    const archived = archiveSessionTranscripts({
      sessionId,
      storePath,
      sessionFile: "/nonexistent/path/file.jsonl",
      reason: "deleted",
    });

    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain(".deleted.");
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });
});
