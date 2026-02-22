import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CliSessionManager } from "./cli-session-manager.js";

describe("CliSessionManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-cli-session-manager-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("static factories", () => {
    test("create() creates a new session manager with transcript file", () => {
      const sessionId = "test-session-create";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);

      const mgr = CliSessionManager.create({
        sessionId,
        sessionFile,
      });

      expect(mgr.getSessionId()).toBe(sessionId);
      expect(mgr.getSessionFile()).toBe(sessionFile);
      expect(fs.existsSync(sessionFile)).toBe(true);

      // Verify header was written
      const content = fs.readFileSync(sessionFile, "utf-8");
      const header = JSON.parse(content.trim());
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);
    });

    test("open() opens existing session and loads entries", () => {
      const sessionId = "test-session-open";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);

      // Write some existing entries
      const lines = [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify({
          type: "message",
          id: "msg1",
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          type: "message",
          id: "msg2",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hi" }],
            timestamp: Date.now(),
          },
        }),
      ];
      fs.writeFileSync(sessionFile, lines.join("\n") + "\n", "utf-8");

      const mgr = CliSessionManager.open(sessionFile, { sessionId });

      expect(mgr.getSessionId()).toBe(sessionId);
      expect(mgr.getEntries()).toHaveLength(2);
      expect(mgr.getLeafId()).toBe("msg2");
    });

    test("open() creates file if it does not exist", () => {
      const sessionId = "test-session-open-new";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);

      expect(fs.existsSync(sessionFile)).toBe(false);

      const mgr = CliSessionManager.open(sessionFile, { sessionId });

      expect(fs.existsSync(sessionFile)).toBe(true);
      expect(mgr.getEntries()).toHaveLength(0);
    });
  });

  describe("accessors", () => {
    test("getSessionId() returns session ID", () => {
      const sessionId = "accessor-test-session";
      const mgr = CliSessionManager.create({
        sessionId,
        sessionFile: path.join(tmpDir, `${sessionId}.jsonl`),
      });

      expect(mgr.getSessionId()).toBe(sessionId);
    });

    test("getLeafId() returns null initially, then entry ID after append", () => {
      const sessionId = "leaf-test-session";
      const mgr = CliSessionManager.create({
        sessionId,
        sessionFile: path.join(tmpDir, `${sessionId}.jsonl`),
      });

      expect(mgr.getLeafId()).toBeNull();

      const entryId = mgr.appendMessage({ role: "user", content: "Hello" });

      expect(mgr.getLeafId()).toBe(entryId);
    });

    test("getLeafEntry() returns the last appended entry", () => {
      const sessionId = "leaf-entry-test";
      const mgr = CliSessionManager.create({
        sessionId,
        sessionFile: path.join(tmpDir, `${sessionId}.jsonl`),
      });

      expect(mgr.getLeafEntry()).toBeUndefined();

      mgr.appendMessage({ role: "user", content: "Hello" });
      const leafEntry = mgr.getLeafEntry();

      expect(leafEntry).toBeDefined();
      expect(leafEntry?.type).toBe("message");
      expect(leafEntry?.message?.role).toBe("user");
    });

    test("isPersisted() returns true when sessionFile is set", () => {
      const mgr = CliSessionManager.create({
        sessionId: "persisted-test",
        sessionFile: path.join(tmpDir, "persisted.jsonl"),
      });

      expect(mgr.isPersisted()).toBe(true);
    });
  });

  describe("appendMessage", () => {
    test("appends user message and returns entry ID", () => {
      const sessionId = "append-user-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({ sessionId, sessionFile });

      const entryId = mgr.appendMessage({ role: "user", content: "Hello world" });

      expect(entryId).toBeDefined();
      expect(typeof entryId).toBe("string");
      expect(entryId.length).toBe(8);

      const entries = mgr.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message?.role).toBe("user");
    });

    test("appends assistant message with usage data", () => {
      const sessionId = "append-assistant-usage-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({
        sessionId,
        sessionFile,
        provider: "claude-cli",
        model: "opus",
      });

      const entryId = mgr.appendMessage({
        role: "assistant",
        content: "Hello!",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          total: 165,
        },
      });

      expect(entryId).toBeDefined();

      // Verify written to file
      const content = fs.readFileSync(sessionFile, "utf-8");
      const lines = content.trim().split("\n");
      // Skip header, get the message entry
      const messageEntry = JSON.parse(lines[lines.length - 1]);

      expect(messageEntry.message.role).toBe("assistant");
      expect(messageEntry.message.usage).toEqual({
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165,
      });
      expect(messageEntry.message.provider).toBe("claude-cli");
      expect(messageEntry.message.model).toBe("opus");
      expect(messageEntry.message.stopReason).toBe("cli_backend");
    });

    test("usage defaults to zeros when not provided", () => {
      const sessionId = "append-no-usage-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({ sessionId, sessionFile });

      mgr.appendMessage({ role: "assistant", content: "Response" });

      const content = fs.readFileSync(sessionFile, "utf-8");
      const lines = content.trim().split("\n");
      const messageEntry = JSON.parse(lines[lines.length - 1]);

      expect(messageEntry.message.usage).toEqual({
        input: 0,
        output: 0,
        cacheRead: undefined,
        cacheWrite: undefined,
        totalTokens: 0,
      });
    });

    test("handles string content", () => {
      const sessionId = "string-content-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({ sessionId, sessionFile });

      mgr.appendMessage({ role: "user", content: "Plain string message" });

      const entry = mgr.getLeafEntry();
      expect(entry?.message?.content).toEqual([{ type: "text", text: "Plain string message" }]);
    });

    test("handles array content", () => {
      const sessionId = "array-content-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({ sessionId, sessionFile });

      mgr.appendMessage({
        role: "user",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      });

      const entry = mgr.getLeafEntry();
      expect(entry?.message?.content).toEqual([
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ]);
    });

    test("sets parentId to previous leaf", () => {
      const sessionId = "parent-id-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({ sessionId, sessionFile });

      const id1 = mgr.appendMessage({ role: "user", content: "First" });
      const id2 = mgr.appendMessage({ role: "assistant", content: "Second" });

      const entries = mgr.getEntries();
      expect(entries[0]?.parentId).toBeUndefined();
      expect(entries[1]?.parentId).toBe(id1);
      expect(mgr.getLeafId()).toBe(id2);
    });
  });

  describe("appendCustomEntry", () => {
    test("appends custom entry and returns entry ID", () => {
      const sessionId = "custom-entry-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({ sessionId, sessionFile });

      const entryId = mgr.appendCustomEntry("tool_result", { result: "success" });

      expect(entryId).toBeDefined();
      expect(mgr.getLeafId()).toBe(entryId);

      const content = fs.readFileSync(sessionFile, "utf-8");
      const lines = content.trim().split("\n");
      const customEntry = JSON.parse(lines[lines.length - 1]);

      expect(customEntry.type).toBe("custom");
      expect(customEntry.customType).toBe("tool_result");
      expect(customEntry.data).toEqual({ result: "success" });
    });
  });

  describe("CLI backend session ID", () => {
    test("setCliBackendSessionId and getCliBackendSessionId", () => {
      const mgr = CliSessionManager.create({
        sessionId: "cli-backend-id-test",
        sessionFile: path.join(tmpDir, "cli-backend.jsonl"),
      });

      expect(mgr.getCliBackendSessionId()).toBeUndefined();

      mgr.setCliBackendSessionId("claude-cli-session-123");

      expect(mgr.getCliBackendSessionId()).toBe("claude-cli-session-123");
    });
  });

  describe("archive", () => {
    test("archives transcript file with reason suffix", () => {
      const sessionId = "archive-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({ sessionId, sessionFile });

      mgr.appendMessage({ role: "user", content: "Message to archive" });

      const archivedPath = mgr.archive("context-overflow");

      expect(archivedPath).toContain("context-overflow");
      expect(fs.existsSync(archivedPath)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(false);
    });
  });

  describe("concurrent write safety", () => {
    test("appendMessageAsync serializes writes", async () => {
      const sessionId = "concurrent-test";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const mgr = CliSessionManager.create({ sessionId, sessionFile });

      // Fire multiple async appends concurrently
      const promises = [
        mgr.appendMessageAsync({ role: "user", content: "Message 1" }),
        mgr.appendMessageAsync({ role: "assistant", content: "Response 1" }),
        mgr.appendMessageAsync({ role: "user", content: "Message 2" }),
        mgr.appendMessageAsync({ role: "assistant", content: "Response 2" }),
      ];

      const ids = await Promise.all(promises);

      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4); // All unique IDs

      const entries = mgr.getEntries();
      expect(entries).toHaveLength(4);

      // Verify parent chain is correct
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]?.parentId).toBe(entries[i - 1]?.id);
      }
    });
  });
});
