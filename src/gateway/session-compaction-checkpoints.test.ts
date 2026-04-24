import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
  persistSessionCompactionCheckpoint,
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

  test("persist removes snapshot files trimmed from checkpoint metadata", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-state-"));
    tempDirs.push(stateDir);
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const checkpoints = await Promise.all(
      Array.from({ length: 25 }, async (_, index) => {
        const sessionFile = path.join(sessionsDir, `sess.checkpoint.${index}.jsonl`);
        await fs.writeFile(sessionFile, `checkpoint ${index}`, "utf-8");
        return {
          checkpointId: `checkpoint-${index}`,
          sessionKey: "agent:main:main",
          sessionId: "sess",
          createdAt: index,
          reason: "auto-threshold",
          preCompaction: { sessionId: "sess", sessionFile, leafId: `leaf-${index}` },
          postCompaction: { sessionId: "sess" },
        };
      }),
    );
    const droppedFile = checkpoints[0].preCompaction.sessionFile;
    const retainedFile = checkpoints[1].preCompaction.sessionFile;
    const newSnapshotFile = path.join(sessionsDir, "sess.checkpoint.new.jsonl");
    await fs.writeFile(newSnapshotFile, "new checkpoint", "utf-8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": {
          sessionId: "sess",
          updatedAt: 1,
          compactionCheckpoints: checkpoints,
        },
      }),
      "utf-8",
    );

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const stored = await persistSessionCompactionCheckpoint({
        cfg: {} as unknown as OpenClawConfig,
        sessionKey: "main",
        sessionId: "sess",
        reason: "auto-threshold",
        snapshot: {
          sessionId: "sess",
          sessionFile: newSnapshotFile,
          leafId: "leaf-new",
        },
      });
      expect(stored).not.toBeNull();
    });

    const store = JSON.parse(
      await fs.readFile(path.join(sessionsDir, "sessions.json"), "utf-8"),
    ) as Record<string, { compactionCheckpoints?: unknown[] }>;
    expect(store["agent:main:main"]?.compactionCheckpoints).toHaveLength(25);
    expect(fsSync.existsSync(droppedFile)).toBe(false);
    expect(fsSync.existsSync(retainedFile)).toBe(true);
    expect(fsSync.existsSync(newSnapshotFile)).toBe(true);
  });
});
