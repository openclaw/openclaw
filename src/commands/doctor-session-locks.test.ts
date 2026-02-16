import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import { noteSessionLockHealth } from "./doctor-session-locks.js";

describe("noteSessionLockHealth", () => {
  let root: string;
  let prevStateDir: string | undefined;

  beforeEach(async () => {
    note.mockReset();
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-locks-"));
    process.env.OPENCLAW_STATE_DIR = root;
  });

  afterEach(async () => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports existing lock files with pid status and age", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const lockPath = path.join(sessionsDir, "active.jsonl.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 1500).toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({ shouldRepair: false, staleMs: 60_000 });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session locks");
    expect(message).toContain("Found 1 session lock file");
    expect(message).toContain(`pid=${process.pid} (alive)`);
    expect(message).toContain("stale=no");
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it("removes stale locks in repair mode", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const staleLock = path.join(sessionsDir, "stale.jsonl.lock");
    const freshLock = path.join(sessionsDir, "fresh.jsonl.lock");

    await fs.writeFile(
      staleLock,
      JSON.stringify({ pid: -1, createdAt: new Date(Date.now() - 120_000).toISOString() }),
      "utf8",
    );
    await fs.writeFile(
      freshLock,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({ shouldRepair: true, staleMs: 30_000 });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("[removed]");
    expect(message).toContain("Removed 1 stale session lock file");

    await expect(fs.access(staleLock)).rejects.toThrow();
    await expect(fs.access(freshLock)).resolves.toBeUndefined();
  });
});
