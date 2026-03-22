import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  buildHandoffPromptSection,
  cleanupHandoffFiles,
  consumeModelHandoff,
  createModelHandoff,
  extractUserMessagesFromTranscript,
  readModelHandoff,
  resolveHandoffPath,
  type SessionHandoff,
} from "./model-handoff.js";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-handoff-test-"));
});

afterAll(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeTranscript(sessionId: string, lines: unknown[]): string {
  const filePath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
  return filePath;
}

describe("extractUserMessagesFromTranscript", () => {
  test("extracts user messages and ignores assistant messages", () => {
    const filePath = writeTranscript("extract-basic", [
      { type: "session", version: 1, id: "extract-basic" },
      { message: { role: "user", content: "Hello" } },
      { message: { role: "assistant", content: "Hi there, how can I help?" } },
      { message: { role: "user", content: "Run the news pipeline" } },
      { message: { role: "assistant", content: "Sure, running now..." } },
    ]);

    const messages = extractUserMessagesFromTranscript(filePath);
    expect(messages).toEqual(["Hello", "Run the news pipeline"]);
  });

  test("handles array content format", () => {
    const filePath = writeTranscript("extract-array", [
      { message: { role: "user", content: [{ type: "text", text: "Array message" }] } },
    ]);

    const messages = extractUserMessagesFromTranscript(filePath);
    expect(messages).toEqual(["Array message"]);
  });

  test("handles input_text content format", () => {
    const filePath = writeTranscript("extract-input-text", [
      { message: { role: "user", content: [{ type: "input_text", text: "Input text" }] } },
    ]);

    const messages = extractUserMessagesFromTranscript(filePath);
    expect(messages).toEqual(["Input text"]);
  });

  test("skips inter-session forwarded messages", () => {
    const filePath = writeTranscript("extract-skip-inter", [
      {
        message: {
          role: "user",
          content: "Forwarded",
          provenance: { kind: "inter_session" },
        },
      },
      { message: { role: "user", content: "Real message" } },
    ]);

    const messages = extractUserMessagesFromTranscript(filePath);
    expect(messages).toEqual(["Real message"]);
  });

  test("returns only the last N messages", () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push({ message: { role: "user", content: `Message ${i}` } });
    }
    const filePath = writeTranscript("extract-limit", lines);

    const messages = extractUserMessagesFromTranscript(filePath, 3);
    expect(messages).toEqual(["Message 7", "Message 8", "Message 9"]);
  });

  test("truncates long messages", () => {
    const longText = "a".repeat(300);
    const filePath = writeTranscript("extract-truncate", [
      { message: { role: "user", content: longText } },
    ]);

    const messages = extractUserMessagesFromTranscript(filePath, 5, 50);
    expect(messages).toHaveLength(1);
    expect(messages[0].length).toBe(50);
    expect(messages[0].endsWith("...")).toBe(true);
  });

  test("skips empty and whitespace-only messages", () => {
    const filePath = writeTranscript("extract-empty", [
      { message: { role: "user", content: "" } },
      { message: { role: "user", content: "  " } },
      { message: { role: "user", content: "Valid" } },
    ]);

    const messages = extractUserMessagesFromTranscript(filePath);
    expect(messages).toEqual(["Valid"]);
  });

  test("returns empty array for missing file", () => {
    const messages = extractUserMessagesFromTranscript("/nonexistent/file.jsonl");
    expect(messages).toEqual([]);
  });

  test("handles malformed JSON lines gracefully", () => {
    const filePath = path.join(tmpDir, "extract-malformed.jsonl");
    fs.writeFileSync(
      filePath,
      ["not valid json", JSON.stringify({ message: { role: "user", content: "Valid" } })].join(
        "\n",
      ),
      "utf-8",
    );

    const messages = extractUserMessagesFromTranscript(filePath);
    expect(messages).toEqual(["Valid"]);
  });
});

describe("resolveHandoffPath", () => {
  test("creates a safe filename from session key", () => {
    const sessionsDir = path.join(os.tmpdir(), "sessions");
    const result = resolveHandoffPath(sessionsDir, "telegram:381198032");
    expect(result).toBe(path.join(sessionsDir, "handoff-telegram_381198032.json"));
  });

  test("handles complex session keys", () => {
    const sessionsDir = path.join(os.tmpdir(), "sessions");
    const result = resolveHandoffPath(sessionsDir, "agent:main:group:-1003833119217");
    expect(result).toBe(path.join(sessionsDir, "handoff-agent_main_group_-1003833119217.json"));
  });
});

describe("createModelHandoff", () => {
  test("creates handoff file from transcript", () => {
    const transcriptPath = writeTranscript("handoff-create", [
      { type: "session", version: 1, id: "handoff-create" },
      { message: { role: "user", content: "Run the news pipeline" } },
      { message: { role: "assistant", content: "I'll describe the steps..." } },
      { message: { role: "user", content: "No, actually execute it" } },
    ]);

    const handoff = createModelHandoff({
      sessionsDir: tmpDir,
      sessionKey: "test:user1",
      transcriptPath,
      previousModel: "minimax/MiniMax-Text-01",
      previousProvider: "minimax",
      newModel: "moonshot/kimi-k2.5",
    });

    expect(handoff).not.toBeNull();
    expect(handoff!.recentUserMessages).toEqual(["Run the news pipeline", "No, actually execute it"]);
    expect(handoff!.previousModel).toBe("minimax/MiniMax-Text-01");
    expect(handoff!.newModel).toBe("moonshot/kimi-k2.5");

    // Verify the file was written
    const handoffPath = resolveHandoffPath(tmpDir, "test:user1");
    expect(fs.existsSync(handoffPath)).toBe(true);
  });

  test("returns null when no user messages exist", () => {
    const transcriptPath = writeTranscript("handoff-empty", [
      { type: "session", version: 1, id: "handoff-empty" },
      { message: { role: "assistant", content: "Only assistant messages" } },
    ]);

    const handoff = createModelHandoff({
      sessionsDir: tmpDir,
      sessionKey: "test:empty",
      transcriptPath,
    });

    expect(handoff).toBeNull();
  });
});

describe("readModelHandoff", () => {
  test("reads existing handoff file", () => {
    const handoffData: SessionHandoff = {
      switchedAt: new Date().toISOString(),
      previousModel: "minimax/MiniMax-Text-01",
      newModel: "moonshot/kimi-k2.5",
      sessionKey: "test:read",
      recentUserMessages: ["Hello", "Run pipeline"],
    };
    const handoffPath = resolveHandoffPath(tmpDir, "test:read");
    fs.writeFileSync(handoffPath, JSON.stringify(handoffData), "utf-8");

    const result = readModelHandoff(tmpDir, "test:read");
    expect(result).not.toBeNull();
    expect(result!.recentUserMessages).toEqual(["Hello", "Run pipeline"]);
  });

  test("returns null for missing handoff", () => {
    const result = readModelHandoff(tmpDir, "test:nonexistent");
    expect(result).toBeNull();
  });

  test("discards stale handoff files", () => {
    const staleHandoff: SessionHandoff = {
      switchedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      sessionKey: "test:stale",
      recentUserMessages: ["Old message"],
    };
    const handoffPath = resolveHandoffPath(tmpDir, "test:stale");
    fs.writeFileSync(handoffPath, JSON.stringify(staleHandoff), "utf-8");

    const result = readModelHandoff(tmpDir, "test:stale");
    expect(result).toBeNull();
    // Verify the stale file was cleaned up
    expect(fs.existsSync(handoffPath)).toBe(false);
  });
});

describe("consumeModelHandoff", () => {
  test("reads and deletes handoff file", () => {
    const handoffData: SessionHandoff = {
      switchedAt: new Date().toISOString(),
      sessionKey: "test:consume",
      recentUserMessages: ["Hello"],
    };
    const handoffPath = resolveHandoffPath(tmpDir, "test:consume");
    fs.writeFileSync(handoffPath, JSON.stringify(handoffData), "utf-8");

    const result = consumeModelHandoff(tmpDir, "test:consume");
    expect(result).not.toBeNull();
    expect(result!.recentUserMessages).toEqual(["Hello"]);

    // File should be deleted after consume
    expect(fs.existsSync(handoffPath)).toBe(false);
  });

  test("returns null when no handoff exists", () => {
    const result = consumeModelHandoff(tmpDir, "test:no-consume");
    expect(result).toBeNull();
  });
});

describe("buildHandoffPromptSection", () => {
  test("builds prompt with user messages and model info", () => {
    const handoff: SessionHandoff = {
      switchedAt: new Date().toISOString(),
      previousModel: "minimax/MiniMax-Text-01",
      newModel: "moonshot/kimi-k2.5",
      sessionKey: "test:prompt",
      recentUserMessages: ["Run the news pipeline", "I need the video today"],
    };

    const prompt = buildHandoffPromptSection(handoff);

    expect(prompt).toContain("[Model Handoff Notice]");
    expect(prompt).toContain("minimax/MiniMax-Text-01");
    expect(prompt).toContain("Run the news pipeline");
    expect(prompt).toContain("I need the video today");
    expect(prompt).toContain("do not imitate");
  });
});

describe("cleanupHandoffFiles", () => {
  test("removes old handoff files beyond limit", () => {
    const cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-handoff-cleanup-"));

    // Create 7 handoff files
    for (let i = 0; i < 7; i++) {
      const name = `handoff-session_${i}.json`;
      const filePath = path.join(cleanupDir, name);
      fs.writeFileSync(filePath, JSON.stringify({ switchedAt: new Date().toISOString() }));
      // Stagger mtime so ordering is deterministic
      const mtime = new Date(Date.now() - i * 1000);
      fs.utimesSync(filePath, mtime, mtime);
    }

    const removed = cleanupHandoffFiles(cleanupDir);

    // Should keep 5 (MAX_HANDOFF_FILES) and remove 2
    expect(removed).toBe(2);

    const remaining = fs.readdirSync(cleanupDir).filter((n) => n.startsWith("handoff-"));
    expect(remaining).toHaveLength(5);

    fs.rmSync(cleanupDir, { recursive: true, force: true });
  });

  test("handles non-existent directory gracefully", () => {
    const removed = cleanupHandoffFiles("/nonexistent/directory");
    expect(removed).toBe(0);
  });
});
