import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatLocalSessionTimestamp,
  wrapSessionManagerWithLocalTimestamps,
} from "./local-session-timestamps.js";

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("local session timestamps", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("formats a local ISO string with an explicit offset", () => {
    const source = "2026-03-19T04:34:13.123Z";
    const formatted = formatLocalSessionTimestamp(source);

    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(formatted.endsWith("Z")).toBe(false);
    expect(Date.parse(formatted)).toBe(Date.parse(source));
  });

  it("writes local-offset timestamps for new session headers and entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-ts-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionManager = wrapSessionManagerWithLocalTimestamps(SessionManager.open(sessionFile));

    sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "openai-responses",
      provider: "openclaw",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    const entries = readJsonl(sessionFile);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.timestamp).toEqual(
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/),
      );
      expect(String(entry.timestamp).endsWith("Z")).toBe(false);
    }
  });

  it("normalizes branched session rewrites to local-offset timestamps", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-branch-ts-"));
    tempDirs.push(tempDir);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionManager = wrapSessionManagerWithLocalTimestamps(SessionManager.open(sessionFile));

    sessionManager.appendMessage({
      role: "user",
      content: "first",
      timestamp: 1,
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
      api: "openai-responses",
      provider: "openclaw",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    const branchedFile = sessionManager.createBranchedSession(sessionManager.getLeafId());
    expect(branchedFile).toBeTruthy();
    const entries = readJsonl(String(branchedFile));

    for (const entry of entries) {
      expect(entry.timestamp).toEqual(
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/),
      );
      expect(String(entry.timestamp).endsWith("Z")).toBe(false);
    }
  });
});
