import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceLock, withWorkspaceLock } from "./workspace-lock-manager.js";

let fixtureRoot = "";
let caseId = 0;

async function makeCaseDir(): Promise<string> {
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function expectedLockPath(targetPath: string, kind: "file" | "dir"): Promise<string> {
  const resolved = path.resolve(targetPath);
  const normalized =
    kind === "dir"
      ? await fs.realpath(resolved).catch(() => resolved)
      : path.join(
          await fs.realpath(path.dirname(resolved)).catch(() => path.dirname(resolved)),
          path.basename(resolved),
        );
  const digest = createHash("sha256").update(`${kind}:${normalized}`).digest("hex").slice(0, 24);
  const lockBaseDir = kind === "dir" ? normalized : path.join(os.tmpdir(), "openclaw");
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
    const lockPath = await expectedLockPath(target, "file");

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
    const lockPath = await expectedLockPath(workspaceDir, "dir");

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
    expect(lock.lockPath).toBe(await expectedLockPath(target, "file"));
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
    expect(lock.lockPath).toBe(await expectedLockPath(target, "file"));

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

    const normalizedWorkspaceDir = await fs
      .realpath(workspaceDir)
      .catch(() => path.resolve(workspaceDir));
    expect(lock.lockPath).toBe(await expectedLockPath(workspaceDir, "dir"));
    const relative = path.relative(normalizedWorkspaceDir, lock.lockPath);
    expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);

    await lock.release();
  });

  it("reclaims expired lock even when pid appears alive", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "expired-owned.txt");
    const lockPath = await expectedLockPath(target, "file");

    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        token: "expired-owner",
        pid: process.pid,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        targetPath: target,
        kind: "file",
      }),
      "utf8",
    );

    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 10,
    });
    await lock.release();
  });

  it("cleans up lock artifact when initial payload write fails", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "write-failure.txt");
    const lockPath = await expectedLockPath(target, "file");

    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags as string, mode as number | undefined);
      return {
        ...handle,
        writeFile: vi.fn().mockRejectedValue(new Error("ENOSPC")),
      } as unknown as Awaited<ReturnType<typeof fs.open>>;
    });

    await expect(
      acquireWorkspaceLock(target, {
        kind: "file",
        timeoutMs: 25,
        pollIntervalMs: 5,
        ttlMs: 1_000,
      }),
    ).rejects.toThrow(/ENOSPC/);

    await expect(fs.stat(lockPath)).rejects.toThrow();
    openSpy.mockRestore();
  });

  it("blocks same-process alias contention on the same canonical file", async () => {
    const dir = await makeCaseDir();
    const realDir = path.join(dir, "real");
    const aliasDir = path.join(dir, "alias");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, aliasDir, "dir");

    const realTarget = path.join(realDir, "shared.txt");
    const aliasTarget = path.join(aliasDir, "shared.txt");

    const lockA = await acquireWorkspaceLock(realTarget, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    await expect(
      acquireWorkspaceLock(aliasTarget, {
        kind: "file",
        timeoutMs: 25,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      }),
    ).rejects.toThrow(/workspace lock timeout/);

    await lockA.release();

    const lockB = await acquireWorkspaceLock(aliasTarget, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });
    await lockB.release();
  });

  it("canonicalizes file path casing when realpath provides canonical case", async () => {
    const dir = await makeCaseDir();
    const canonicalPath = path.join(dir, "Shared.txt");
    const mixedCaseAlias = path.join(dir, "shared.txt");
    await fs.writeFile(canonicalPath, "x", "utf8");

    const originalRealpath = fs.realpath.bind(fs);
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (value) => {
      const asString = String(value);
      const resolved = path.resolve(asString);
      const aliasResolved = path.resolve(mixedCaseAlias);
      const sameAliasPath =
        resolved === aliasResolved || resolved.toLowerCase() === aliasResolved.toLowerCase();
      if (sameAliasPath) {
        return canonicalPath;
      }
      return originalRealpath(value);
    });

    try {
      const lockA = await acquireWorkspaceLock(canonicalPath, {
        kind: "file",
        timeoutMs: 100,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      });

      await expect(
        acquireWorkspaceLock(mixedCaseAlias, {
          kind: "file",
          timeoutMs: 25,
          pollIntervalMs: 5,
          ttlMs: 5_000,
        }),
      ).rejects.toThrow(/workspace lock timeout/);

      await lockA.release();

      const lockB = await acquireWorkspaceLock(mixedCaseAlias, {
        kind: "file",
        timeoutMs: 100,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      });
      await lockB.release();
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("does not create missing target parent directories for file locks", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "missing", "nested", "notes.txt");
    const missingParent = path.dirname(target);

    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    await expect(fs.stat(missingParent)).rejects.toThrow();
    await lock.release();
  });

  it("canonicalizes missing-file targets through existing symlinked ancestors", async () => {
    const dir = await makeCaseDir();
    const realDir = path.join(dir, "real");
    const aliasDir = path.join(dir, "alias");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, aliasDir, "dir");

    const realTarget = path.join(realDir, "new", "state.json");
    const aliasTarget = path.join(aliasDir, "new", "state.json");

    const lockA = await acquireWorkspaceLock(realTarget, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    await expect(
      acquireWorkspaceLock(aliasTarget, {
        kind: "file",
        timeoutMs: 25,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      }),
    ).rejects.toThrow(/workspace lock timeout/);

    await lockA.release();

    const lockB = await acquireWorkspaceLock(aliasTarget, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });
    await lockB.release();
  });

  it("preserves case-sensitive distinct missing-file lock targets", async () => {
    const dir = await makeCaseDir();
    const targetUpper = path.join(dir, "New", "State.JSON");
    const targetLower = path.join(dir, "new", "state.json");

    const lockA = await acquireWorkspaceLock(targetUpper, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    const lockB = await acquireWorkspaceLock(targetLower, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    expect(lockA.lockPath).not.toBe(lockB.lockPath);

    await lockA.release();
    await lockB.release();
  });

  it("keeps file lock path stable when parent directories appear later", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "new", "nested", "state.json");

    const lockA = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    await fs.mkdir(path.dirname(target), { recursive: true });

    await expect(
      acquireWorkspaceLock(target, {
        kind: "file",
        timeoutMs: 25,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      }),
    ).rejects.toThrow(/workspace lock timeout/);

    const firstPath = lockA.lockPath;
    await lockA.release();

    const lockB = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    expect(firstPath).toBe(lockB.lockPath);
    await lockB.release();
  });

  it("keeps mixed-case lock identity stable after materialization", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "New", "State.JSON");

    const lockA = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });
    const firstPath = lockA.lockPath;

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "payload", "utf8");

    await expect(
      acquireWorkspaceLock(target, {
        kind: "file",
        timeoutMs: 25,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      }),
    ).rejects.toThrow(/workspace lock timeout/);

    await lockA.release();

    const lockB = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });
    expect(lockB.lockPath).toBe(firstPath);
    await lockB.release();
  });

  it("backs off when stale lock deletion fails", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "busy.txt");
    const lockPath = await expectedLockPath(target, "file");

    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        token: "stale-token",
        pid: 999_999,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 30_000).toISOString(),
        targetPath: target,
        kind: "file",
      }),
      "utf8",
    );

    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (filePath, options) => {
      if (String(filePath) === lockPath) {
        throw new Error("EACCES");
      }
      return originalRm(filePath, options);
    });

    try {
      const started = Date.now();
      await expect(
        acquireWorkspaceLock(target, {
          kind: "file",
          timeoutMs: 30,
          pollIntervalMs: 20,
          ttlMs: 1,
        }),
      ).rejects.toThrow(/workspace lock timeout/);
      const elapsed = Date.now() - started;

      expect(rmSpy).toHaveBeenCalled();
      expect(elapsed).toBeGreaterThanOrEqual(20);
    } finally {
      rmSpy.mockRestore();
      await fs.rm(lockPath, { force: true });
    }
  });

  it("does not let stale handle callbacks release a newer lock owner", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "stale-handle.txt");

    const first = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });
    const staleRelease = first.release;

    await first.release();

    const second = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    await staleRelease();

    await expect(
      acquireWorkspaceLock(target, {
        kind: "file",
        timeoutMs: 25,
        pollIntervalMs: 5,
        ttlMs: 5_000,
      }),
    ).rejects.toThrow(/workspace lock timeout/);

    await second.release();
  });
});
