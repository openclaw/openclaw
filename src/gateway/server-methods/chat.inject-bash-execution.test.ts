// Guardrail: TUI-local `!`/`!!` shell command persistence must attach to the current
// leaf with a `parentId` (like other injected transcript messages) and must round-trip
// excludeFromContext so `!!` output never reaches the model while `!` output does.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { appendInjectedBashExecutionMessageToTranscript } from "./chat-transcript-inject.js";
import { createTranscriptFixtureSync } from "./chat.test-helpers.js";

function readLastTranscriptRecord(transcriptPath: string): Record<string, unknown> {
  const lines = fs
    .readFileSync(transcriptPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  return JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
}

describe("appendInjectedBashExecutionMessageToTranscript", () => {
  it("appends a bashExecution message with parentId, agent-visible by default", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-bash-",
      sessionId: "sess-1",
    });
    try {
      const appended = await appendInjectedBashExecutionMessageToTranscript({
        transcriptPath,
        command: "ls",
        output: "a.txt\nb.txt",
        exitCode: 0,
      });

      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTypeOf("string");

      const last = readLastTranscriptRecord(transcriptPath);
      expect(Object.hasOwn(last, "parentId")).toBe(true);
      const message = last.message as Record<string, unknown>;
      expect(message.role).toBe("bashExecution");
      expect(message.command).toBe("ls");
      expect(message.output).toBe("a.txt\nb.txt");
      expect(message.exitCode).toBe(0);
      // `!` (agent-visible): excludeFromContext must not be set at all.
      expect(Object.hasOwn(message, "excludeFromContext")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists excludeFromContext: true for a `!!` command", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-bash-bangbang-",
      sessionId: "sess-1",
    });
    try {
      const appended = await appendInjectedBashExecutionMessageToTranscript({
        transcriptPath,
        command: "cat secrets.env",
        output: "API_KEY=fake",
        exitCode: 0,
        excludeFromContext: true,
      });

      expect(appended.ok).toBe(true);
      const last = readLastTranscriptRecord(transcriptPath);
      const message = last.message as Record<string, unknown>;
      expect(message.role).toBe("bashExecution");
      expect(message.excludeFromContext).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when transcript identity is unresolved", async () => {
    const appended = await appendInjectedBashExecutionMessageToTranscript({
      command: "ls",
      output: "",
    });
    expect(appended.ok).toBe(false);
    expect(appended.error).toBeTypeOf("string");
  });
});
