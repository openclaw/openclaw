import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionCheckpointStore } from "./session-checkpoint.js";

describe("SessionCheckpointStore", () => {
  let store: SessionCheckpointStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
    store = new SessionCheckpointStore({
      checkpointDir: tmpDir,
      maxPerSession: 3,
      minIntervalMs: 0, // Disable throttle for tests
    });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const makeCheckpoint = (sessionId: string, extra?: Record<string, unknown>) => ({
    sessionId,
    agentId: "main",
    createdAt: Date.now(),
    transcriptLength: 10,
    ...extra,
  });

  it("saves and loads a checkpoint", async () => {
    const data = makeCheckpoint("s1", { lastKnownCostUsd: 0.42 });
    const saved = await store.save(data);
    expect(saved).toBe(true);

    const loaded = await store.loadLatest("s1");
    expect(loaded).toBeDefined();
    expect(loaded?.sessionId).toBe("s1");
    expect(loaded?.lastKnownCostUsd).toBe(0.42);
  });

  it("returns null for unknown session", async () => {
    const loaded = await store.loadLatest("nonexistent");
    expect(loaded).toBeNull();
  });

  it("loads most recent checkpoint", async () => {
    await store.save(makeCheckpoint("s1", { transcriptLength: 5 }));
    await new Promise((r) => setTimeout(r, 10));
    await store.save(makeCheckpoint("s1", { transcriptLength: 20 }));

    const loaded = await store.loadLatest("s1");
    expect(loaded?.transcriptLength).toBe(20);
  });

  it("prunes old checkpoints beyond maxPerSession", async () => {
    for (let i = 0; i < 5; i++) {
      await store.save(makeCheckpoint("s1", { transcriptLength: i }));
      await new Promise((r) => setTimeout(r, 10));
    }

    const all = await store.listCheckpoints("s1");
    expect(all.length).toBe(3);
    // Most recent should be transcriptLength 4
    expect(all[0]?.transcriptLength).toBe(4);
  });

  it("deletes all checkpoints for a session", async () => {
    await store.save(makeCheckpoint("s1"));
    await store.save(makeCheckpoint("s1"));
    await store.deleteSession("s1");

    const loaded = await store.loadLatest("s1");
    expect(loaded).toBeNull();
  });

  it("finds recoverable sessions", async () => {
    await store.save(makeCheckpoint("session-a"));
    await store.save(makeCheckpoint("session-b"));

    const sessions = await store.findRecoverableSessions();
    expect(sessions).toContain("session-a");
    expect(sessions).toContain("session-b");
    expect(sessions.length).toBe(2);
  });

  it("enforces minimum interval", async () => {
    const throttled = new SessionCheckpointStore({
      checkpointDir: tmpDir,
      minIntervalMs: 60_000,
    });

    const first = await throttled.save(makeCheckpoint("s1"));
    expect(first).toBe(true);

    const second = await throttled.save(makeCheckpoint("s1"));
    expect(second).toBe(false);
  });

  it("handles sessions independently", async () => {
    await store.save(makeCheckpoint("s1", { activeModel: "claude" }));
    await store.save(makeCheckpoint("s2", { activeModel: "gpt4" }));

    const s1 = await store.loadLatest("s1");
    const s2 = await store.loadLatest("s2");
    expect(s1?.activeModel).toBe("claude");
    expect(s2?.activeModel).toBe("gpt4");
  });

  it("sanitizes session IDs for filesystem", async () => {
    const data = makeCheckpoint("agent:main:thread:1234/5678");
    await store.save(data);

    const loaded = await store.loadLatest("agent:main:thread:1234/5678");
    expect(loaded?.sessionId).toBe("agent:main:thread:1234/5678");
  });
});
