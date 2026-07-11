import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  readLatestRecentSessionUsageFromTranscriptAsync,
  readRecentSessionMessagesWithStats,
  readRecentSessionTranscriptLines,
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
  readSessionMessagesAsync,
  readSessionTitleFieldsFromTranscript,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

describe("session transcript reader facade", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-readers-"));
    storePath = path.join(tempDir, "sessions.json");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTranscript(sessionId: string, events: unknown[]): SessionTranscriptReadScope {
    const transcriptPath = path.join(tempDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf-8",
    );
    return { sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
  }

  test("reads active-branch messages and message ids through a scope", async () => {
    const scope = writeTranscript("reader-active-branch", [
      { type: "session", version: 3, id: "reader-active-branch" },
      {
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root prompt" },
      },
      {
        type: "message",
        id: "inactive",
        parentId: "root",
        message: { role: "assistant", content: "stale answer" },
      },
      {
        type: "message",
        id: "active",
        parentId: "root",
        message: { role: "assistant", content: "active answer" },
      },
    ]);

    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "facade active branch test" }),
    ).resolves.toMatchObject([{ content: "root prompt" }, { content: "active answer" }]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(2);
    await expect(readSessionMessageByIdAsync(scope, "active")).resolves.toMatchObject({
      found: true,
      oversized: false,
      seq: 2,
    });
  });

  test("reads recent tails with total counts through a scope", () => {
    const scope = writeTranscript("reader-recent-tail", [
      { type: "session", version: 1, id: "reader-recent-tail" },
      { message: { role: "user", content: "old" } },
      { message: { role: "assistant", content: "middle" } },
      { message: { role: "user", content: "recent" } },
      { message: { role: "assistant", content: "latest" } },
    ]);

    const messages = readRecentSessionMessagesWithStats(scope, {
      maxMessages: 2,
      maxBytes: 2048,
    });
    const tail = readRecentSessionTranscriptLines({ ...scope, maxLines: 3 });

    expect(messages.totalMessages).toBe(4);
    expect(messages.messages).toMatchObject([{ content: "recent" }, { content: "latest" }]);
    expect(tail?.totalLines).toBe(5);
    expect(tail?.lines.map((line) => JSON.parse(line).message?.content)).toEqual([
      "middle",
      "recent",
      "latest",
    ]);
  });

  test("reads title fields and recent usage through a scope", async () => {
    const scope = writeTranscript("reader-title-usage", [
      { type: "session", version: 1, id: "reader-title-usage" },
      { message: { role: "user", content: "derive this title" } },
      {
        message: {
          role: "assistant",
          content: "metered answer",
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 11,
            output: 7,
            contextUsage: { state: "unavailable" },
          },
        },
      },
    ]);

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "derive this title",
      lastMessagePreview: "metered answer",
    });
    await expect(
      readLatestRecentSessionUsageFromTranscriptAsync(scope, 4096),
    ).resolves.toMatchObject({
      inputTokens: 11,
      contextUsage: { state: "unavailable" },
      model: "gpt-5.5",
      modelProvider: "openai",
      outputTokens: 7,
    });
  });

  test("honors agent ids when no store path or session file is provided", async () => {
    const sessionId = "reader-agent-scope";
    const transcriptDir = path.join(tempDir, "agents", "agent-one", "sessions");
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "message",
        id: "agent-message",
        parentId: null,
        message: { role: "user", content: "agent scoped prompt" },
      })}\n`,
      "utf-8",
    );
    const scope = { agentId: "agent-one", sessionId };

    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(1);
    await expect(readSessionMessageByIdAsync(scope, "agent-message")).resolves.toMatchObject({
      found: true,
      seq: 1,
    });
    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "facade agent scope test" }),
    ).resolves.toMatchObject([{ content: "agent scoped prompt" }]);
  });
});
