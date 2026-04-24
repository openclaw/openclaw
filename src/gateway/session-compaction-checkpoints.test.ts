import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
} from "./session-compaction-checkpoints.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-compaction-checkpoints", () => {
  test("capture stores the copied pre-compaction transcript path and cleanup removes only the copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    const userMessage: UserMessage = {
      role: "user",
      content: "before compaction",
      timestamp: Date.now(),
    };
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "working on it" }],
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    session.appendMessage(userMessage);
    session.appendMessage(assistantMessage);

    const sessionFile = session.getSessionFile();
    const leafId = session.getLeafId();
    expect(sessionFile).toBeTruthy();
    expect(leafId).toBeTruthy();

    const originalBefore = await fs.readFile(sessionFile!, "utf-8");
    const snapshot = captureCompactionCheckpointSnapshot({
      sessionManager: session,
      sessionFile: sessionFile!,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.leafId).toBe(leafId);
    expect(snapshot?.sessionFile).not.toBe(sessionFile);
    expect(snapshot?.sessionFile).toContain(".checkpoint.");
    expect(fsSync.existsSync(snapshot!.sessionFile)).toBe(true);
    expect(await fs.readFile(snapshot!.sessionFile, "utf-8")).toBe(originalBefore);

    session.appendCompaction("checkpoint summary", leafId!, 123, { ok: true });

    expect(await fs.readFile(snapshot!.sessionFile, "utf-8")).toBe(originalBefore);
    expect(await fs.readFile(sessionFile!, "utf-8")).not.toBe(originalBefore);

    await cleanupCompactionCheckpointSnapshot(snapshot);

    expect(fsSync.existsSync(snapshot!.sessionFile)).toBe(false);
    expect(fsSync.existsSync(sessionFile!)).toBe(true);
  });
});
