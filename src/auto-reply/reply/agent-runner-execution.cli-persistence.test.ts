import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendAssistantMessageToTranscript,
  appendMessageToTranscript,
  appendMessageToTranscriptAsync,
} from "../../gateway/session-utils.fs.js";

describe("CLI backend transcript persistence", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-cli-persist-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("user message persisted before CLI run", () => {
    const sessionId = "test-user-persist";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    const result = appendMessageToTranscript({
      message: "Hello from user",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: true,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const msgLine = JSON.parse(lines[1]);
    expect(msgLine.message.role).toBe("user");
    expect(msgLine.message.content[0].text).toBe("Hello from user");
  });

  test("assistant response persisted after successful CLI run with provider/model", () => {
    const sessionId = "test-assistant-persist";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    // First persist user message
    appendMessageToTranscript({
      message: "User question",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: true,
    });

    // Then persist assistant response with provider/model
    const result = appendAssistantMessageToTranscript({
      message: "Assistant response",
      sessionId,
      storePath,
      provider: "claude-cli",
      model: "claude-3-opus",
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);

    const msgLine = JSON.parse(lines[2]);
    expect(msgLine.message.role).toBe("assistant");
    expect(msgLine.message.content[0].text).toBe("Assistant response");
    expect(msgLine.message.provider).toBe("claude-cli");
    expect(msgLine.message.model).toBe("claude-3-opus");
  });

  test("error response persisted when CLI fails", () => {
    const sessionId = "test-error-persist";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    // First persist user message
    appendMessageToTranscript({
      message: "User question",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: true,
    });

    // Simulate error being persisted
    const errorResult = appendAssistantMessageToTranscript({
      message: "[CLI error: Connection timeout]",
      sessionId,
      storePath,
      provider: "claude-cli",
      model: "claude-3-opus",
    });

    expect(errorResult.ok).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);

    const msgLine = JSON.parse(lines[2]);
    expect(msgLine.message.role).toBe("assistant");
    expect(msgLine.message.content[0].text).toContain("[CLI error:");
  });

  test("persistence failure returns error but does not throw", () => {
    const sessionId = "test-persist-fail";
    // Use invalid path that cannot be created
    const invalidStorePath = "/nonexistent/deeply/nested/sessions.json";

    const result = appendMessageToTranscript({
      message: "Test message",
      role: "user",
      sessionId,
      storePath: invalidStorePath,
      createIfMissing: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("empty CLI response still recorded to maintain turn consistency", () => {
    const sessionId = "test-empty-response";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    // First persist user message
    appendMessageToTranscript({
      message: "User question",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: true,
    });

    // Persist empty response
    const result = appendAssistantMessageToTranscript({
      message: "",
      sessionId,
      storePath,
      provider: "claude-cli",
      model: "claude-3-opus",
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);

    const msgLine = JSON.parse(lines[2]);
    expect(msgLine.message.role).toBe("assistant");
    expect(msgLine.message.content[0].text).toBe("");
  });

  test("persistence preserves role alternation (user -> assistant)", () => {
    const sessionId = "test-role-alternation";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    // Simulate multiple turns
    appendMessageToTranscript({
      message: "First user message",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: true,
    });

    appendAssistantMessageToTranscript({
      message: "First assistant response",
      sessionId,
      storePath,
    });

    appendMessageToTranscript({
      message: "Second user message",
      role: "user",
      sessionId,
      storePath,
    });

    appendAssistantMessageToTranscript({
      message: "Second assistant response",
      sessionId,
      storePath,
    });

    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(5); // header + 4 messages

    const roles = lines.slice(1).map((line) => JSON.parse(line).message.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("partial failure: user persists but assistant fails leaves orphaned message", () => {
    const sessionId = "test-partial-failure";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    // User message persists successfully
    const userResult = appendMessageToTranscript({
      message: "User question",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: true,
    });
    expect(userResult.ok).toBe(true);

    // Make file read-only to simulate assistant persistence failure
    fs.chmodSync(transcriptPath, 0o444);

    try {
      // Assistant message should fail
      const assistantResult = appendAssistantMessageToTranscript({
        message: "Response",
        sessionId,
        storePath,
      });

      expect(assistantResult.ok).toBe(false);
      expect(assistantResult.error).toBeDefined();

      // Verify orphaned user message exists
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2); // header + user message only (orphaned)

      const roles = lines.slice(1).map((line) => JSON.parse(line).message.role);
      expect(roles).toEqual(["user"]); // No assistant response
    } finally {
      // Restore permissions for cleanup
      fs.chmodSync(transcriptPath, 0o644);
    }
  });

  test("concurrent writes with async version maintain transcript integrity", async () => {
    const sessionId = "test-concurrent-async";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

    // Create initial file
    appendMessageToTranscript({
      message: "Initial",
      role: "user",
      sessionId,
      storePath,
      createIfMissing: true,
    });

    // Launch 10 concurrent writes using async version with locking
    const writes = Array.from({ length: 10 }, (_, i) =>
      appendMessageToTranscriptAsync({
        message: `Concurrent message ${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        sessionId,
        storePath,
      }),
    );

    const results = await Promise.all(writes);

    // All writes should succeed
    expect(results.every((r) => r.ok)).toBe(true);

    // Verify all messages are present and valid JSON
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(12); // header + initial + 10 concurrent

    // All lines should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
