import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { persistVisibleAssistantTextToTranscript } from "./chat-visible-text-persistence.js";

function createTranscriptFile(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sessionFile = path.join(dir, "sess.jsonl");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "sess-1",
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  return sessionFile;
}

describe("persistVisibleAssistantTextToTranscript", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the preserved visible prefix into the latest assistant transcript entry", () => {
    const sessionFile = createTranscriptFile("openclaw-visible-text-persist-");
    createdDirs.push(path.dirname(sessionFile));
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Complete reply" }],
      timestamp: 1,
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as Parameters<typeof sessionManager.appendMessage>[0]);

    expect(
      persistVisibleAssistantTextToTranscript({
        sessionFile,
        sessionKey: "main",
        visibleText: "Streamed prefix:",
      }),
    ).toBe(true);

    const assistantEntry = SessionManager.open(sessionFile)
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    expect(assistantEntry?.type).toBe("message");
    expect((assistantEntry as { message: { text?: string } }).message.text).toBe(
      "Streamed prefix: Complete reply",
    );
  });

  it("fills commentary-only assistant entries with the streamed visible text", () => {
    const sessionFile = createTranscriptFile("openclaw-visible-text-commentary-");
    createdDirs.push(path.dirname(sessionFile));
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "thinking like caveman",
          textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
        },
      ],
      timestamp: 1,
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as Parameters<typeof sessionManager.appendMessage>[0]);

    expect(
      persistVisibleAssistantTextToTranscript({
        sessionFile,
        sessionKey: "main",
        visibleText: "Visible streamed text",
      }),
    ).toBe(true);

    const assistantEntry = SessionManager.open(sessionFile)
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    expect(assistantEntry?.type).toBe("message");
    expect((assistantEntry as { message: { text?: string } }).message.text).toBe(
      "Visible streamed text",
    );
  });
});
