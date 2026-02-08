import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readTranscriptLeafId } from "./chat.js";

describe("readTranscriptLeafId", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null for non-existent file", () => {
    const result = readTranscriptLeafId(path.join(tempDir, "missing.jsonl"));
    expect(result).toBeNull();
  });

  it("returns null for empty file", () => {
    const filePath = path.join(tempDir, "empty.jsonl");
    fs.writeFileSync(filePath, "", "utf-8");
    expect(readTranscriptLeafId(filePath)).toBeNull();
  });

  it("returns null for file with only a session header", () => {
    const filePath = path.join(tempDir, "header-only.jsonl");
    const header = JSON.stringify({ type: "session", id: "s1", version: 1 });
    fs.writeFileSync(filePath, `${header}\n`, "utf-8");
    expect(readTranscriptLeafId(filePath)).toBeNull();
  });

  it("returns the last message entry id", () => {
    const filePath = path.join(tempDir, "multi.jsonl");
    const header = JSON.stringify({ type: "session", id: "s1", version: 1 });
    const msg1 = JSON.stringify({ type: "message", id: "aaa", message: {} });
    const msg2 = JSON.stringify({ type: "message", id: "bbb", message: {} });
    fs.writeFileSync(filePath, `${header}\n${msg1}\n${msg2}\n`, "utf-8");
    expect(readTranscriptLeafId(filePath)).toBe("bbb");
  });

  it("skips trailing non-message entries", () => {
    const filePath = path.join(tempDir, "trailing.jsonl");
    const msg = JSON.stringify({ type: "message", id: "ccc", message: {} });
    const summary = JSON.stringify({ type: "summary", id: "s1" });
    fs.writeFileSync(filePath, `${msg}\n${summary}\n`, "utf-8");
    expect(readTranscriptLeafId(filePath)).toBe("ccc");
  });
});
