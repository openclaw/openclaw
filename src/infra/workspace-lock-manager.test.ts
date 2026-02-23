import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireWorkspaceLock, withWorkspaceLock } from "./workspace-lock-manager.js";

let fixtureRoot = "";
let caseId = 0;

async function makeCaseDir(): Promise<string> {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("workspace lock manager", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-locks-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("enforces contention for file locks", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "state.json");
    const lockPath = `${target}.lock`;

    const livePayload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      targetPath: target,
      kind: "file",
    };
    await fs.writeFile(lockPath, JSON.stringify(livePayload), "utf8");

    await expect(
      acquireWorkspaceLock(target, {
        kind: "file",
        timeoutMs: 25,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      }),
    ).rejects.toThrow(/workspace lock timeout/);
  });

  it("reclaims stale lock for directory targets", async () => {
    const dir = await makeCaseDir();
    const workspaceDir = path.join(dir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const lockPath = path.join(workspaceDir, ".openclaw.workspace.lock");

    const stalePayload = {
      pid: 999_999,
      createdAt: new Date(Date.now() - 20_000).toISOString(),
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
      targetPath: workspaceDir,
      kind: "dir",
    };
    await fs.writeFile(lockPath, JSON.stringify(stalePayload), "utf8");

    const lock = await acquireWorkspaceLock(workspaceDir, {
      kind: "dir",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 1_000,
    });

    const refreshedRaw = await fs.readFile(lock.lockPath, "utf8");
    const refreshed = JSON.parse(refreshedRaw) as { pid: number; kind: string; expiresAt: string };
    expect(refreshed.pid).toBe(process.pid);
    expect(refreshed.kind).toBe("dir");
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.now());

    await lock.release();
  });

  it("always releases lock in withWorkspaceLock finally path", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "notes.md");

    await expect(
      withWorkspaceLock(
        target,
        {
          kind: "file",
          timeoutMs: 100,
          pollIntervalMs: 5,
          ttlMs: 5_000,
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });
    expect(lock.lockPath).toBe(`${target}.lock`);
    await lock.release();
  });
});
