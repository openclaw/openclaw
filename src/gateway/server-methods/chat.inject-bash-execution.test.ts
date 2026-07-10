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

  it("appends as a side entry while an agent run owns the active leaf", async () => {
    // Regression: injecting a `!` result while a run is mid-turn used to append an
    // active-leaf entry, which the run's session-file fence reported as a takeover
    // ("session file changed while embedded prompt lock was released"), killing the run.
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-bash-midrun-",
      sessionId: "sess-1",
    });
    try {
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: "run something", timestamp: 1 },
        })}\n${JSON.stringify({
          // The leaf control an in-flight run leaves while released for its prompt.
          type: "leaf",
          id: "leaf-1",
          parentId: "user-1",
          targetId: "user-1",
          appendParentId: "user-1",
          appendMode: "side",
        })}\n`,
        "utf-8",
      );

      const appended = await appendInjectedBashExecutionMessageToTranscript({
        transcriptPath,
        command: "echo mid-run",
        output: "mid-run",
        exitCode: 0,
      });

      expect(appended.ok).toBe(true);
      const last = readLastTranscriptRecord(transcriptPath);
      expect((last.message as Record<string, unknown>).role).toBe("bashExecution");
      expect(last.parentId).toBe("user-1");
      // Side append: the run keeps the active leaf and adopts this entry later.
      expect(last.appendMode).toBe("side");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends as a normal active entry when no run holds the leaf", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-bash-idle-",
      sessionId: "sess-1",
    });
    try {
      const appended = await appendInjectedBashExecutionMessageToTranscript({
        transcriptPath,
        command: "echo idle",
        output: "idle",
        exitCode: 0,
      });

      expect(appended.ok).toBe(true);
      const last = readLastTranscriptRecord(transcriptPath);
      expect(Object.hasOwn(last, "appendMode")).toBe(false);
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
