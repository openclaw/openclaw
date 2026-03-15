// src/config/sessions/history.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionRecentMessages } from "./history.js";
import { saveSessionStore } from "./store.js";

describe("readSessionRecentMessages", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when session key not found", async () => {
    await saveSessionStore(storePath, {});
    const result = await readSessionRecentMessages({
      storePath,
      sessionKey: "nonexistent",
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when session file does not exist", async () => {
    await saveSessionStore(storePath, {
      "test-key": { sessionId: "missing-session-id", updatedAt: Date.now() },
    });
    const result = await readSessionRecentMessages({
      storePath,
      sessionKey: "test-key",
    });
    expect(result).toEqual([]);
  });

  it("reads messages from session transcript", async () => {
    const sessionId = "test-session-abc123";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);

    await saveSessionStore(storePath, {
      "test-key": { sessionId, updatedAt: Date.now() },
    });

    const header = JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: tmpDir,
    });
    await fs.writeFile(sessionFile, `${header}\n`, "utf-8");

    const manager = SessionManager.open(sessionFile);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello world" }],
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
      api: "openai-responses",
      provider: "openclaw",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const result = await readSessionRecentMessages({
      storePath,
      sessionKey: "test-key",
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: "user", content: "hello world" });
    expect(result[1]).toMatchObject({ role: "assistant", content: "hi there" });
  });

  it("respects limit parameter", async () => {
    const sessionId = "test-session-limit";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);

    await saveSessionStore(storePath, {
      "limit-key": { sessionId, updatedAt: Date.now() },
    });

    const header = JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: tmpDir,
    });
    // Write header + 5 user messages + 1 assistant message directly to trigger
    // SessionManager's persist logic (which only flushes once an assistant
    // message exists). Writing the JSONL manually avoids that constraint.
    const lines: string[] = [header];
    let prevId: string | null = null;
    for (let i = 0; i < 5; i++) {
      const id = `user${i}00000`;
      lines.push(
        JSON.stringify({
          type: "message",
          id,
          parentId: prevId,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: `message ${i}` }],
            timestamp: Date.now(),
          },
        }),
      );
      prevId = id;
    }
    await fs.writeFile(sessionFile, lines.join("\n") + "\n", "utf-8");

    const result = await readSessionRecentMessages({
      storePath,
      sessionKey: "limit-key",
      limit: 3,
    });

    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({ content: "message 4" });
  });

  it("returns empty array on any error (graceful degradation)", async () => {
    const result = await readSessionRecentMessages({
      storePath: path.join(tmpDir, "nonexistent", "sessions.json"),
      sessionKey: "any-key",
    });
    expect(result).toEqual([]);
  });

  it("does not create directories when session file does not exist", async () => {
    const sessionId = "ghost-session-no-file";
    await saveSessionStore(storePath, {
      "ghost-key": { sessionId, updatedAt: Date.now() },
    });

    // Snapshot tmpDir contents before the call
    const beforeContents = await fs.readdir(tmpDir);

    await readSessionRecentMessages({
      storePath,
      sessionKey: "ghost-key",
    });

    // Snapshot after the call — no new entries should appear
    const afterContents = await fs.readdir(tmpDir);
    expect(afterContents).toEqual(beforeContents);
  });

  it("excludes toolResult messages from returned history", async () => {
    const sessionId = "test-session-tool-result";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);

    await saveSessionStore(storePath, {
      "tool-key": { sessionId, updatedAt: Date.now() },
    });

    const header = JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: tmpDir,
    });

    const lines: string[] = [header];
    // user message
    lines.push(
      JSON.stringify({
        type: "message",
        id: "user001",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "run my tool" }],
          timestamp: Date.now(),
        },
      }),
    );
    // toolResult message — should be excluded
    lines.push(
      JSON.stringify({
        type: "message",
        id: "tool001",
        parentId: "user001",
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "call_abc",
          toolName: "bash",
          content: [{ type: "text", text: "tool output" }],
          isError: false,
          timestamp: Date.now(),
        },
      }),
    );
    // assistant message
    lines.push(
      JSON.stringify({
        type: "message",
        id: "asst001",
        parentId: "tool001",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "openai-responses",
          provider: "openclaw",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      }),
    );
    await fs.writeFile(sessionFile, lines.join("\n") + "\n", "utf-8");

    const result = await readSessionRecentMessages({
      storePath,
      sessionKey: "tool-key",
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: "user", content: "run my tool" });
    expect(result[1]).toMatchObject({ role: "assistant", content: "done" });
    // toolResult must not appear
    expect(result.find((m) => m.role === ("toolResult" as string))).toBeUndefined();
  });
});
