import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHeartbeatSessionContext } from "./heartbeat-runner.js";

describe("loadHeartbeatSessionContext", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  async function createSandbox() {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-ctx-"));
    cleanupDirs.push(tmpDir);
    const storePath = path.join(tmpDir, "sessions.json");
    return { tmpDir, storePath };
  }

  function makeTranscriptLine(role: string, text: string): string {
    return JSON.stringify({
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      message: { role, content: [{ type: "text", text }] },
    });
  }

  async function writeTranscript(dir: string, sessionId: string, lines: string[]): Promise<string> {
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(filePath, lines.join("\n") + "\n");
    return filePath;
  }

  it("returns undefined when entry has no sessionId", async () => {
    const { storePath } = await createSandbox();
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: undefined,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when transcript file does not exist", async () => {
    const { storePath } = await createSandbox();
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "nonexistent" },
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when transcript has only assistant messages", async () => {
    const { tmpDir, storePath } = await createSandbox();
    await writeTranscript(tmpDir, "sess-1", [
      makeTranscriptLine("assistant", "Hey there!"),
      makeTranscriptLine("assistant", "How are you?"),
    ]);
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-1" },
    });
    expect(result).toBeUndefined();
  });

  it("returns formatted context with user and assistant messages", async () => {
    const { tmpDir, storePath } = await createSandbox();
    await writeTranscript(tmpDir, "sess-2", [
      makeTranscriptLine("user", "Hey, heading to Madrid next week"),
      makeTranscriptLine("assistant", "Oh nice! Flying direct?"),
      makeTranscriptLine("user", "Direct, 10 hours"),
      makeTranscriptLine("assistant", "Pack snacks and a neck pillow"),
    ]);
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-2" },
    });
    expect(result).toBeDefined();
    expect(result).toContain("[Recent conversation history");
    expect(result).toContain("User: Hey, heading to Madrid next week");
    expect(result).toContain("You: Oh nice! Flying direct?");
    expect(result).toContain("User: Direct, 10 hours");
    expect(result).toContain("You: Pack snacks and a neck pillow");
  });

  it("includes silence duration from file mtime", async () => {
    const { tmpDir, storePath } = await createSandbox();
    const filePath = await writeTranscript(tmpDir, "sess-3", [
      makeTranscriptLine("user", "Hello"),
      makeTranscriptLine("assistant", "Hi there"),
    ]);
    // Set mtime to 2.5 hours ago.
    const twoHoursAgo = new Date(Date.now() - 2.5 * 60 * 60_000);
    await fs.utimes(filePath, twoHoursAgo, twoHoursAgo);

    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-3" },
    });
    expect(result).toContain("(last message ~2h 30m ago)");
  });

  it("truncates long messages", async () => {
    const { tmpDir, storePath } = await createSandbox();
    const longMsg = "A".repeat(1000);
    await writeTranscript(tmpDir, "sess-4", [
      makeTranscriptLine("user", longMsg),
      makeTranscriptLine("assistant", "Noted"),
    ]);
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-4" },
    });
    expect(result).toBeDefined();
    // Should be truncated to 500 chars + ellipsis.
    expect(result).toContain("A".repeat(500) + "…");
    expect(result).not.toContain("A".repeat(501));
  });

  it("keeps only the last N messages", async () => {
    const { tmpDir, storePath } = await createSandbox();
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(makeTranscriptLine(i % 2 === 0 ? "user" : "assistant", `Message ${i}`));
    }
    await writeTranscript(tmpDir, "sess-5", lines);
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-5" },
    });
    expect(result).toBeDefined();
    // Should NOT contain early messages.
    expect(result).not.toContain("Message 0");
    expect(result).not.toContain("Message 9");
    // Should contain recent messages.
    expect(result).toContain("Message 29");
    expect(result).toContain("Message 10");
  });

  it("skips system messages in the transcript", async () => {
    const { tmpDir, storePath } = await createSandbox();
    await writeTranscript(tmpDir, "sess-6", [
      makeTranscriptLine("system", "System prompt"),
      makeTranscriptLine("user", "Hello"),
      makeTranscriptLine("assistant", "Hi"),
    ]);
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-6" },
    });
    expect(result).toBeDefined();
    expect(result).not.toContain("System prompt");
    expect(result).toContain("User: Hello");
    expect(result).toContain("You: Hi");
  });

  it("injects context when window has one user message among many assistant messages", async () => {
    const { tmpDir, storePath } = await createSandbox();
    const lines = [
      makeTranscriptLine("user", "Heading out, talk later"),
      ...Array.from({ length: 15 }, (_, i) =>
        makeTranscriptLine("assistant", `Heartbeat output ${i}`),
      ),
    ];
    await writeTranscript(tmpDir, "sess-8", lines);
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-8" },
    });
    // Should still inject — the one user message is enough to avoid the
    // assistant-only feedback loop guard.
    expect(result).toBeDefined();
    expect(result).toContain("User: Heading out, talk later");
    expect(result).toContain("You: Heartbeat output 0");
  });

  it("handles plain string content format", async () => {
    const { tmpDir, storePath } = await createSandbox();
    const line = JSON.stringify({
      id: "msg-str",
      message: { role: "user", content: "Plain string content" },
    });
    await writeTranscript(tmpDir, "sess-7", [line, makeTranscriptLine("assistant", "Got it")]);
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-7" },
    });
    expect(result).toBeDefined();
    expect(result).toContain("User: Plain string content");
  });

  it("excludes heartbeat prompt messages to prevent recursive nesting", async () => {
    const { tmpDir, storePath } = await createSandbox();
    await writeTranscript(tmpDir, "sess-9", [
      makeTranscriptLine("user", "Hey, heading to Madrid"),
      makeTranscriptLine("assistant", "Nice! Flying direct?"),
      // Heartbeat prompt with injected context (recorded as user message).
      makeTranscriptLine(
        "user",
        "[Recent conversation history — use this for context when composing your message] (last message ~2h ago)\nUser: Hey, heading to Madrid\nYou: Nice! Flying direct?\n\nRead HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      ),
      makeTranscriptLine("assistant", "HEARTBEAT_OK"),
      // Plain heartbeat prompt without context injection.
      makeTranscriptLine(
        "user",
        "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      ),
      makeTranscriptLine("assistant", "HEARTBEAT_OK"),
    ]);
    const result = loadHeartbeatSessionContext({
      storePath,
      agentId: "default",
      entry: { sessionId: "sess-9" },
    });
    expect(result).toBeDefined();
    // Real user message should be included.
    expect(result).toContain("User: Hey, heading to Madrid");
    expect(result).toContain("You: Nice! Flying direct?");
    // Heartbeat prompts should be excluded — the preamble appears exactly once
    // (the one we generate), not nested from a prior heartbeat's transcript entry.
    expect(result?.match(/\[Recent conversation history/g)?.length).toBe(1);
    // Only the real user message, not the heartbeat prompt messages.
    expect(result?.match(/User:/g)?.length).toBe(1);
  });
});
