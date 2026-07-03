/**
 * Tests for removeAllSessionLocksOnShutdown.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeAllSessionLocksOnShutdown } from "./stale-lock-cleanup-shutdown.js";

async function makeTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-shutdown-test-"));
}

async function writeLock(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    "utf8",
  );
}

describe("removeAllSessionLocksOnShutdown", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 when agents directory does not exist", async () => {
    const env = { OPENCLAW_STATE_DIR: path.join(tmpDir, "nonexistent") };
    const count = await removeAllSessionLocksOnShutdown(env);
    expect(count).toBe(0);
  });

  it("removes all .jsonl.lock files unconditionally", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "agent-a", "sessions");
    const lock1 = path.join(sessionsDir, "s1.jsonl.lock");
    const lock2 = path.join(sessionsDir, "s2.jsonl.lock");
    await writeLock(lock1);
    await writeLock(lock2);

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await removeAllSessionLocksOnShutdown(env);
    expect(count).toBe(2);

    await expect(fs.access(lock1)).rejects.toThrow();
    await expect(fs.access(lock2)).rejects.toThrow();
  });

  it("does not remove non-lock files", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "agent-b", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const jsonlFile = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(jsonlFile, "data\n", "utf8");
    await writeLock(path.join(sessionsDir, "session.jsonl.lock"));

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await removeAllSessionLocksOnShutdown(env);
    expect(count).toBe(1);

    await expect(fs.access(jsonlFile)).resolves.toBeUndefined();
  });

  it("handles multiple agents", async () => {
    for (const agentId of ["agent-1", "agent-2", "agent-3"]) {
      const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
      await writeLock(path.join(sessionsDir, "main.jsonl.lock"));
    }

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await removeAllSessionLocksOnShutdown(env);
    expect(count).toBe(3);
  });

  it("skips agents with missing sessions directory without throwing", async () => {
    // Create agent dir but no sessions subdir
    await fs.mkdir(path.join(tmpDir, "agents", "no-sessions-agent"), { recursive: true });

    // Add one agent with a lock to confirm it still works
    const sessionsDir = path.join(tmpDir, "agents", "agent-ok", "sessions");
    await writeLock(path.join(sessionsDir, "s.jsonl.lock"));

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await removeAllSessionLocksOnShutdown(env);
    expect(count).toBe(1);
  });

  it("returns 0 when no lock files are present", async () => {
    await fs.mkdir(path.join(tmpDir, "agents", "agent-empty", "sessions"), { recursive: true });

    const env = { OPENCLAW_STATE_DIR: tmpDir };
    const count = await removeAllSessionLocksOnShutdown(env);
    expect(count).toBe(0);
  });
});
