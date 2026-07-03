/**
 * Tests for sweepStaleSessionLocksOnStartup.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStaleSessionLocksOnStartup } from "./stale-lock-cleanup-startup.js";

const STALE_AGE_MS = 120_000;

async function makeTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-startup-test-"));
}

async function writeLock(filePath: string, ageMs: number, pid = 99999999): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ pid, createdAt: new Date(Date.now() - ageMs).toISOString() }),
    "utf8",
  );
}

describe("sweepStaleSessionLocksOnStartup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 when agents directory does not exist", async () => {
    const env = { OPENCLAW_STATE_DIR: path.join(tmpDir, "nonexistent") };
    const count = await sweepStaleSessionLocksOnStartup(env);
    expect(count).toBe(0);
  });

  it("removes lock files older than 120s", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "agent-a", "sessions");
    const lockPath = path.join(sessionsDir, "session1.jsonl.lock");
    await writeLock(lockPath, STALE_AGE_MS + 1000);

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await sweepStaleSessionLocksOnStartup(env);
    expect(count).toBe(1);

    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("leaves lock files newer than 120s in place", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "agent-b", "sessions");
    const lockPath = path.join(sessionsDir, "session2.jsonl.lock");
    // 60 seconds old — under threshold, and held by a live pid.
    await writeLock(lockPath, 60_000, process.pid);

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await sweepStaleSessionLocksOnStartup(env, {
      readOwnerProcessArgs: () => ["node", "/opt/openclaw/openclaw.mjs", "gateway"],
    });
    expect(count).toBe(0);

    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it("returns 0 when no lock files are present", async () => {
    await fs.mkdir(path.join(tmpDir, "agents", "agent-c", "sessions"), { recursive: true });

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await sweepStaleSessionLocksOnStartup(env);
    expect(count).toBe(0);
  });

  it("handles multiple agents, removes only stale locks", async () => {
    const staleDir = path.join(tmpDir, "agents", "agent-stale", "sessions");
    const staleLock = path.join(staleDir, "old.jsonl.lock");
    await writeLock(staleLock, STALE_AGE_MS + 5000);

    const freshDir = path.join(tmpDir, "agents", "agent-fresh", "sessions");
    const freshLock = path.join(freshDir, "new.jsonl.lock");
    await writeLock(freshLock, 10_000, process.pid);

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await sweepStaleSessionLocksOnStartup(env, {
      readOwnerProcessArgs: (pid) =>
        pid === process.pid ? ["node", "/opt/openclaw/openclaw.mjs", "gateway"] : null,
    });
    expect(count).toBe(1);

    await expect(fs.access(staleLock)).rejects.toThrow();
    await expect(fs.access(freshLock)).resolves.toBeUndefined();
  });
});
