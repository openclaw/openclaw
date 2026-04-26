import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
  persistSessionCompactionCheckpoint,
} from "./session-compaction-checkpoints.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";

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

  test("persist trims old checkpoint metadata and removes trimmed snapshot files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-trim-"));
    tempDirs.push(dir);

    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sess";
    const sessionKey = "agent:main:main";
    const now = Date.now();
    const existingCheckpoints = Array.from({ length: 26 }, (_, index) => {
      const uuid = `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
      const sessionFile = path.join(dir, `sess.checkpoint.${uuid}.jsonl`);
      fsSync.writeFileSync(sessionFile, `checkpoint ${index}`, "utf-8");
      return {
        checkpointId: `old-${index}`,
        sessionKey,
        sessionId,
        createdAt: now + index,
        reason: "manual" as const,
        preCompaction: {
          sessionId,
          sessionFile,
          leafId: `old-leaf-${index}`,
        },
        postCompaction: { sessionId },
      };
    });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: now,
            compactionCheckpoints: existingCheckpoints,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const currentSnapshotFile = path.join(
      dir,
      "sess.checkpoint.99999999-9999-4999-8999-999999999999.jsonl",
    );
    await fs.writeFile(currentSnapshotFile, "current", "utf-8");

    const stored = await persistSessionCompactionCheckpoint({
      cfg: {
        session: { store: storePath },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      sessionKey: "main",
      sessionId,
      reason: "manual",
      snapshot: {
        sessionId,
        sessionFile: currentSnapshotFile,
        leafId: "current-leaf",
      },
      createdAt: now + 100,
    });

    expect(stored).not.toBeNull();
    expect(fsSync.existsSync(existingCheckpoints[0].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[1].preCompaction.sessionFile)).toBe(false);
    expect(fsSync.existsSync(existingCheckpoints[2].preCompaction.sessionFile)).toBe(true);
    expect(fsSync.existsSync(currentSnapshotFile)).toBe(true);

    const nextStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { compactionCheckpoints?: unknown[] }
    >;
    expect(
      Object.values(nextStore).find((entry) => entry.compactionCheckpoints)?.compactionCheckpoints,
    ).toHaveLength(25);

test("persist stores boundary id and metadata with the checkpoint", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-store-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    const cfg = {
      session: { scope: "global", mainKey: "main", store: storePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    await fs.mkdir(path.dirname(target.storePath), { recursive: true });
    const checkpointCreatedAt = Date.now();
    await fs.writeFile(
      target.storePath,
      JSON.stringify({
        [target.canonicalKey]: { sessionId: "session-live", updatedAt: checkpointCreatedAt },
      }),
      "utf8",
    );
    const boundaryMetadata = {
      version: 1,
      type: "compact.boundary",
      boundaryId: "compact-boundary:diag-1",
      createdAt: 123,
      state: {
        sessionBinding: { sessionKey: "main", sessionId: "session-live" },
        approval: { captured: false, reason: "captured elsewhere" },
        outbound: { channel: "discord", targetId: "user-1" },
        children: { pendingDescendantState: "live-query-required" },
        policy: { provider: "openai", model: "gpt-test", thinkingLevel: "high" },
      },
    } as const;

    const checkpoint = await persistSessionCompactionCheckpoint({
      cfg,
      sessionKey: "main",
      sessionId: "session-live",
      reason: "manual",
      snapshot: {
        sessionId: "session-pre",
        sessionFile: path.join(dir, "pre.jsonl"),
        leafId: "leaf-pre",
      },
      postSessionFile: path.join(dir, "post.jsonl"),
      postLeafId: "leaf-post",
      postEntryId: "leaf-post",
      createdAt: checkpointCreatedAt,
      boundaryMetadata,
    });

    expect(checkpoint?.boundaryId).toBe("compact-boundary:diag-1");
    expect(checkpoint?.boundaryMetadata).toEqual(boundaryMetadata);

    const stored = JSON.parse(await fs.readFile(target.storePath, "utf8")) as Record<
      string,
      { compactionCheckpoints?: Array<Record<string, unknown>> }
    >;
    const storedEntry = stored[checkpoint!.sessionKey];
    expect(storedEntry.compactionCheckpoints).toHaveLength(1);
    expect(storedEntry.compactionCheckpoints?.[0]).toMatchObject({
      boundaryId: "compact-boundary:diag-1",
      boundaryMetadata,
    });

  });
});
