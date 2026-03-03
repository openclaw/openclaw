import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn((_sessionId: string) => ""),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
  resolveMainSessionKey: vi.fn(() => "main"),
}));

const sessions = await import("../config/sessions.js");
const resolveSessionFilePathMock = vi.mocked(sessions.resolveSessionFilePath);

const { getTranscriptInfo, buildStatusMessage } = await import("./status.js");

describe("getTranscriptInfo", () => {
  let tmpDir: string;
  let testFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-test-"));
    testFilePath = path.join(tmpDir, "test-session.jsonl");
    resolveSessionFilePathMock.mockReturnValue(testFilePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when sessionId is missing", () => {
    expect(getTranscriptInfo({})).toBeUndefined();
  });

  it("returns undefined when file does not exist", () => {
    resolveSessionFilePathMock.mockReturnValue(path.join(tmpDir, "nonexistent.jsonl"));
    expect(getTranscriptInfo({ sessionId: "abc" })).toBeUndefined();
  });

  it("returns size and message count for a transcript file", () => {
    const lines = [
      JSON.stringify({ message: { role: "user", content: "hello" } }),
      JSON.stringify({ message: { role: "assistant", content: "hi" } }),
      "",
    ];
    fs.writeFileSync(testFilePath, lines.join("\n"));
    const info = getTranscriptInfo({ sessionId: "abc" });
    expect(info).toBeDefined();
    expect(info!.messageCount).toBe(2);
    expect(info!.sizeBytes).toBeGreaterThan(0);
    expect(info!.filePath).toBe(testFilePath);
  });

  it("counts only non-empty lines", () => {
    const content = '{"a":1}\n\n\n{"b":2}\n{"c":3}\n\n';
    fs.writeFileSync(testFilePath, content);
    const info = getTranscriptInfo({ sessionId: "abc" });
    expect(info!.messageCount).toBe(3);
  });
});

describe("transcript line in buildStatusMessage", () => {
  it("includes transcript line when transcriptInfo is provided", () => {
    const info = {
      sizeBytes: 512_000,
      messageCount: 42,
      filePath: "/tmp/test.jsonl",
    };
    const result = buildStatusMessage({
      agent: {},
      transcriptInfo: info,
    });
    expect(result).toContain("📄 Transcript:");
    expect(result).toContain("500.0 KB");
    expect(result).toContain("42 messages");
  });

  it("shows warning emoji for large transcripts", () => {
    const info = {
      sizeBytes: 2 * 1024 * 1024,
      messageCount: 600,
      filePath: "/tmp/test.jsonl",
    };
    const result = buildStatusMessage({
      agent: {},
      transcriptInfo: info,
    });
    expect(result).toContain("⚠️");
    expect(result).toContain("2.0 MB");
  });

  it("omits transcript line when transcriptInfo is undefined", () => {
    const result = buildStatusMessage({
      agent: {},
    });
    expect(result).not.toContain("📄 Transcript:");
  });

  it("handles singular message count", () => {
    const info = {
      sizeBytes: 100,
      messageCount: 1,
      filePath: "/tmp/test.jsonl",
    };
    const result = buildStatusMessage({
      agent: {},
      transcriptInfo: info,
    });
    expect(result).toContain("1 message");
    expect(result).not.toContain("1 messages");
  });
});
