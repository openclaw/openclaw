import { createHash } from "node:crypto";
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

function expectedLockPath(targetPath: string, kind: "file" | "dir"): string {
  const normalized = path.resolve(targetPath);
  const digest = createHash("sha256").update(`${kind}:${normalized}`).digest("hex").slice(0, 24);
  const lockBaseDir = kind === "dir" ? normalized : path.dirname(normalized);
  return path.join(lockBaseDir, ".openclaw.workspace-locks", `${kind}-${digest}.lock`);
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
    const lockPath = expectedLockPath(target, "file");

    const livePayload = {
      token: "live-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      targetPath: target,
      kind: "file",
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
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
    const lockPath = expectedLockPath(workspaceDir, "dir");

    const stalePayload = {
      token: "stale-token",
      pid: 999_999,
      createdAt: new Date(Date.now() - 20_000).toISOString(),
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
      targetPath: workspaceDir,
      kind: "dir",
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
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
    expect(lock.lockPath).toBe(expectedLockPath(target, "file"));
    await lock.release();
  });

  it("does not remove lock file after ownership changed", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "owner.txt");
    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    await fs.writeFile(
      lock.lockPath,
      JSON.stringify({
        token: "foreign-owner",
        pid: process.pid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        targetPath: target,
        kind: "file",
      }),
      "utf8",
    );

    await lock.release();
    const persisted = JSON.parse(await fs.readFile(lock.lockPath, "utf8")) as { token: string };
    expect(persisted.token).toBe("foreign-owner");

    await fs.rm(lock.lockPath, { force: true });
  });

  it("never collides with real <target>.lock files", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "report.json");
    const adjacentDataPath = `${target}.lock`;
    await fs.writeFile(adjacentDataPath, "important-data", "utf8");

    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    expect(lock.lockPath).not.toBe(adjacentDataPath);
    expect(lock.lockPath).toBe(expectedLockPath(target, "file"));

    await lock.release();
    await expect(fs.readFile(adjacentDataPath, "utf8")).resolves.toBe("important-data");
  });

  it("stores dir lock artifacts inside the locked directory", async () => {
    const dir = await makeCaseDir();
    const workspaceDir = path.join(dir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const lock = await acquireWorkspaceLock(workspaceDir, {
      kind: "dir",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    expect(lock.lockPath).toBe(expectedLockPath(workspaceDir, "dir"));
    expect(lock.lockPath.startsWith(path.join(workspaceDir, path.sep))).toBe(true);

    await lock.release();
  });
});
