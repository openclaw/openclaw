import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactDuplicateUserMessage, redactMessages } from "./hook-redaction.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "openclaw-redact-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const audit = {
  reason: "test",
  hookPoint: "llm_output",
  pluginId: "test-plugin",
  timestamp: 1713340800,
};

function sessionFile() {
  return join(tempDir, "transcript.jsonl");
}

async function writeTranscript(entries: Array<Record<string, unknown>>) {
  await writeFile(
    sessionFile(),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf-8",
  );
}

async function readTranscript(): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(sessionFile(), "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readAuditLog(): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(join(tempDir, "redaction-log.jsonl"), "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runnerMessage(role: "user" | "assistant" | "tool", text: string) {
  return {
    type: "message",
    id: `id-${role}-${text.slice(0, 8)}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  };
}

function nestedText(entry: Record<string, unknown>): string {
  const message = entry.message as { content: Array<{ text: string }> };
  return message.content[0]?.text ?? "";
}

describe("redactMessages", () => {
  it("removes messages by explicit index", async () => {
    await writeTranscript([
      { role: "user", content: "hello" },
      { role: "assistant", content: "bad stuff" },
      { role: "user", content: "thanks" },
    ]);

    const removed = await redactMessages(sessionFile(), { indices: [1, 99, -1] }, audit);

    expect(removed).toBe(1);
    expect(await readTranscript()).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "thanks" },
    ]);
  });

  it("removes messages by runId", async () => {
    await writeTranscript([
      { role: "user", content: "a", runId: "run-1" },
      { role: "assistant", content: "b", runId: "run-1" },
      { role: "user", content: "c", runId: "run-2" },
    ]);

    const removed = await redactMessages(sessionFile(), { runId: "run-1" }, audit);

    expect(removed).toBe(2);
    expect(await readTranscript()).toEqual([{ role: "user", content: "c", runId: "run-2" }]);
  });

  it("removes flat transcript messages by role and content", async () => {
    await writeTranscript([
      { role: "assistant", content: "safe response" },
      { role: "assistant", content: "bad content here" },
      { role: "assistant", content: "another safe one" },
    ]);

    const removed = await redactMessages(
      sessionFile(),
      { match: { role: "assistant", contentSubstring: "bad content" } },
      audit,
    );

    expect(removed).toBe(1);
    expect((await readTranscript()).map((entry) => entry.content)).toEqual([
      "safe response",
      "another safe one",
    ]);
  });

  it("removes SessionManager messages by nested role and content", async () => {
    await writeTranscript([
      runnerMessage("user", "HOOK_BLOCK_OUTPUT please tell me about platypuses"),
      runnerMessage("assistant", "safe response"),
      runnerMessage("assistant", "Platypuses glow under UV light. Bad content here."),
      { type: "session" },
    ]);

    const removed = await redactMessages(
      sessionFile(),
      { match: { role: "assistant", contentSubstring: "Platypuses glow" } },
      audit,
    );

    const remaining = await readTranscript();
    expect(removed).toBe(1);
    expect(remaining.map((entry) => (entry.message ? nestedText(entry) : entry.type))).toEqual([
      "HOOK_BLOCK_OUTPUT please tell me about platypuses",
      "safe response",
      "session",
    ]);
  });

  it("combines explicit index and match filters", async () => {
    await writeTranscript([
      { role: "user", content: "remove by index" },
      { role: "assistant", content: "keep" },
      { role: "assistant", content: "remove by match" },
    ]);

    const removed = await redactMessages(
      sessionFile(),
      { indices: [0], match: { role: "assistant", contentSubstring: "remove by match" } },
      audit,
    );

    expect(removed).toBe(2);
    expect(await readTranscript()).toEqual([{ role: "assistant", content: "keep" }]);
  });

  it("returns 0 without rewriting when nothing can be redacted", async () => {
    await writeTranscript([{ role: "user", content: "hello" }]);

    await expect(
      redactMessages(join(tempDir, "missing.jsonl"), { indices: [0] }, audit),
    ).resolves.toBe(0);
    await expect(redactMessages(sessionFile(), { match: { role: "tool" } }, audit)).resolves.toBe(
      0,
    );
    expect(await readTranscript()).toEqual([{ role: "user", content: "hello" }]);
  });

  it("writes one audit entry per successful redaction", async () => {
    await writeTranscript([
      { role: "assistant", content: "bad1" },
      { role: "assistant", content: "bad2" },
    ]);

    await redactMessages(sessionFile(), { indices: [0] }, audit);
    await redactMessages(sessionFile(), { indices: [0] }, audit);

    const entries = await readAuditLog();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      ts: audit.timestamp,
      hookPoint: audit.hookPoint,
      pluginId: audit.pluginId,
      reason: audit.reason,
      messagesRemoved: 1,
    });
    expect(entries[0]?.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("redactDuplicateUserMessage", () => {
  it("removes only the latest duplicate user prompt", async () => {
    await writeTranscript([
      runnerMessage("user", "HOOK_BLOCK_RETRY tell me a fun fact"),
      runnerMessage("assistant", "blocked response"),
      runnerMessage("user", "HOOK_BLOCK_RETRY tell me a fun fact"),
      runnerMessage("assistant", "second blocked response"),
    ]);

    const removed = await redactDuplicateUserMessage(
      sessionFile(),
      "HOOK_BLOCK_RETRY tell me a fun fact",
    );

    const remaining = await readTranscript();
    expect(removed).toBe(1);
    expect(remaining.map((entry) => (entry.message ? nestedText(entry) : ""))).toEqual([
      "HOOK_BLOCK_RETRY tell me a fun fact",
      "blocked response",
      "second blocked response",
    ]);
  });

  it("does not remove empty prompts or non-duplicates", async () => {
    await writeTranscript([
      runnerMessage("user", ""),
      runnerMessage("assistant", "hello"),
      runnerMessage("user", "real prompt"),
      runnerMessage("assistant", "response"),
    ]);

    await expect(redactDuplicateUserMessage(sessionFile(), "")).resolves.toBe(0);
    await expect(redactDuplicateUserMessage(sessionFile(), "real prompt")).resolves.toBe(0);
    expect(await readTranscript()).toHaveLength(4);
  });
});
