import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionLeafId } from "./session-transcript-leaf.js";

describe("readSessionLeafId", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-leaf-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null for non-existent file", () => {
    const storePath = path.join(tempDir, "store.json");
    const result = readSessionLeafId("nonexistent", storePath);
    expect(result).toBeNull();
  });

  it("returns null for empty file", () => {
    const sessionId = "test-session";
    const storePath = path.join(tempDir, "store.json");
    const filePath = path.join(tempDir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, "", "utf-8");

    const result = readSessionLeafId(sessionId, storePath);
    expect(result).toBeNull();
  });

  it("returns the ID of the last entry", () => {
    const sessionId = "test-session";
    const storePath = path.join(tempDir, "store.json");
    const filePath = path.join(tempDir, `${sessionId}.jsonl`);
    const entries = [
      { type: "session", id: "session-1" },
      { id: "msg-1", parentId: null, message: { role: "user" } },
      { id: "msg-2", parentId: "msg-1", message: { role: "assistant" } },
      { id: "msg-3", parentId: "msg-2", message: { role: "user" } },
    ];
    fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const result = readSessionLeafId(sessionId, storePath);
    expect(result).toBe("msg-3");
  });
});
