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
  const lockBaseDir = kind === "dir" ? normalized : path.dirname(normalized);
  return path.join(lockBaseDir, ".openclaw.workspace-locks", `${kind}-${digest}.lock`);
}

describe("workspace lock manager", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-locks-")),
    );
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

  it("preserves parseable payload when refresh write fails", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "refresh-failure.txt");
    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    const beforeRaw = await fs.readFile(lock.lockPath, "utf8");
    const before = JSON.parse(beforeRaw) as { token: string };

    const realOpen = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        const originalWrite = handle.write.bind(handle);
        let failNextWrite = true;
        handle.write = (async (...writeArgs: Parameters<typeof handle.write>) => {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error("simulated write failure");
          }
          return originalWrite(...writeArgs);
        }) as typeof handle.write;
        return handle;
      });

    await lock.refresh();

    const afterRaw = await fs.readFile(lock.lockPath, "utf8");
    const after = JSON.parse(afterRaw) as { token: string };
    expect(after.token).toBe(before.token);

    openSpy.mockRestore();
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

  it("creates lock dir inside the target parent for file locks (cross-user safe)", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "missing", "nested", "notes.txt");
    const missingParent = path.dirname(target);

    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    // Lock dir is created inside the target's parent directory (not in a
    // per-user temp dir) so different OS users converge on the same lock.
    const lockDir = path.join(missingParent, ".openclaw.workspace-locks");
    await expect(fs.stat(lockDir)).resolves.toBeTruthy();
    // The target file itself should NOT exist.
    await expect(fs.stat(target)).rejects.toThrow();
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

  it("does not delete a refreshed lock during stale-reclaim race", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "stale-race.txt");
    const lockPath = await expectedLockPath(target, "file");

    const stalePayload = {
      token: "stale-token",
      pid: 999_999,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30_000).toISOString(),
      targetPath: target,
      kind: "file",
    };
    const freshPayload = {
      token: "fresh-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      targetPath: target,
      kind: "file",
    };

    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(stalePayload), "utf8");

    const originalReadFile = fs.readFile.bind(fs);
    let staged = false;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (typeof filePath === "string" && filePath === lockPath && !staged) {
        staged = true;
        const out = await originalReadFile(filePath, options as never);
        await fs.writeFile(lockPath, JSON.stringify(freshPayload), "utf8");
        return out;
      }
      return await originalReadFile(filePath, options as never);
    });

    try {
      await expect(
        acquireWorkspaceLock(target, {
          kind: "file",
          timeoutMs: 40,
          pollIntervalMs: 10,
          ttlMs: 1,
        }),
      ).rejects.toThrow(/workspace lock timeout/);

      const persisted = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token: string };
      expect(persisted.token).toBe("fresh-token");
    } finally {
      readSpy.mockRestore();
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

  it("does not let stale handle callbacks refresh a newer lock owner", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "stale-refresh.txt");

    const first = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });
    const staleRefresh = first.refresh;

    await first.release();

    const second = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 25,
    });
    const before = JSON.parse(await fs.readFile(second.lockPath, "utf8")) as {
      token: string;
      expiresAt: string;
    };

    await staleRefresh();

    const after = JSON.parse(await fs.readFile(second.lockPath, "utf8")) as {
      token: string;
      expiresAt: string;
    };
    expect(after.token).toBe(before.token);
    expect(after.expiresAt).toBe(before.expiresAt);

    await second.release();
  });

  it("aborts lock acquisition while waiting on a contended lock", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "abort-wait.txt");
    const held = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    const controller = new AbortController();
    const pending = acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 120_000,
      pollIntervalMs: 20,
      ttlMs: 5_000,
      signal: controller.signal,
    });

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await held.release();
  });

  it("refresh produces valid JSON with no trailing garbage after multiple refreshes", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "refresh-integrity.txt");
    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    // Refresh several times to trigger potential truncation bugs
    for (let i = 0; i < 5; i++) {
      await lock.refresh();
    }
    const raw = await fs.readFile(lock.lockPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("token");
    expect(parsed).toHaveProperty("expiresAt");
    // Ensure no trailing characters beyond the JSON payload
    expect(raw).toBe(JSON.stringify(parsed));

    await lock.release();
  });

  it("refresh writes payload from offset 0 so release can still parse and clean up", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "refresh-offset.txt");
    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      pollIntervalMs: 5,
      ttlMs: 5_000,
    });

    await lock.refresh();
    const raw = await fs.readFile(lock.lockPath, "utf8");
    expect(raw.startsWith("{")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();

    await lock.release();
    await expect(fs.stat(lock.lockPath)).rejects.toThrow();
  });

  it("release removes lock file even when handle is still open (Windows EPERM regression)", async () => {
    // Regression: releaseLock must close the file handle BEFORE calling
    // fs.rm, otherwise Windows rejects the unlink with EPERM.
    const dir = await makeCaseDir();
    const target = path.join(dir, "eperm-test.txt");
    await fs.writeFile(target, "data");

    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      ttlMs: 5_000,
    });

    // Lock file should exist before release.
    await expect(fs.stat(lock.lockPath)).resolves.toBeTruthy();

    await lock.release();

    // Lock file must be gone after release.
    await expect(fs.stat(lock.lockPath)).rejects.toThrow();
  });

  it("cross-user convergence: same target produces same lock path regardless of owner", async () => {
    // Regression: lock paths must not depend on the OS user identity so
    // two processes under different UIDs serialize on the same lock file.
    const dir = await makeCaseDir();
    const target = path.join(dir, "shared-file.txt");
    await fs.writeFile(target, "data");

    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      ttlMs: 5_000,
    });

    // Lock file should be inside the target's parent directory, not in a
    // per-user temp directory.
    expect(lock.lockPath).toContain(dir);
    expect(lock.lockPath).not.toContain("uid-");
    expect(lock.lockPath).not.toContain("user-");

    await lock.release();
  });

  it("normalizes unresolved file-path casing on case-insensitive platforms", async () => {
    const dir = await makeCaseDir();
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatformDescriptor) {
      throw new Error("missing process.platform descriptor");
    }

    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "darwin",
    });

    try {
      const upper = await acquireWorkspaceLock(path.join(dir, "New", "State.json"), {
        kind: "file",
        timeoutMs: 100,
        ttlMs: 5_000,
      });
      await upper.release();

      const lower = await acquireWorkspaceLock(path.join(dir, "new", "state.json"), {
        kind: "file",
        timeoutMs: 100,
        ttlMs: 5_000,
      });

      expect(lower.lockPath).toBe(upper.lockPath);
      await lower.release();
    } finally {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("creates cross-user writable lock directories", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "permissions.txt");
    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 100,
      ttlMs: 5_000,
    });

    if (process.platform !== "win32") {
      const stat = await fs.stat(path.dirname(lock.lockPath));
      expect(stat.mode & 0o777).toBe(0o777);
    }

    await lock.release();
  });

  it("should create lock artifacts but not the target file for missing-file paths", async () => {
    const dir = await makeCaseDir();
    const bogusFile = path.join(dir, "new-subdir", "file.txt");

    const lock = await acquireWorkspaceLock(bogusFile, { kind: "file", timeoutMs: 100 });

    // Lock artifacts are created, but the target file itself is not.
    await expect(fs.stat(lock.lockPath)).resolves.toBeTruthy();
    await expect(fs.stat(bogusFile)).rejects.toThrow();

    await lock.release();
  });

  it("should enforce minimum TTL of 200ms so refresh can keep lock alive", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "short-ttl.txt");
    await fs.writeFile(target, "");

    // Even with ttlMs: 1, the lock should survive long enough for a 150ms
    // critical section because the implementation clamps to 200ms.
    let ranToCompletion = false;
    await withWorkspaceLock(target, { kind: "file", ttlMs: 1, timeoutMs: 2000 }, async () => {
      await new Promise((r) => setTimeout(r, 150));
      ranToCompletion = true;
    });
    expect(ranToCompletion).toBe(true);
  });

  it("should refresh lock payload correctly after multiple reads (seek regression)", async () => {
    const dir = await makeCaseDir();
    const target = path.join(dir, "refresh-seek.txt");
    await fs.writeFile(target, "");

    const lock = await acquireWorkspaceLock(target, {
      kind: "file",
      timeoutMs: 1000,
      ttlMs: 500,
    });

    // Refresh should update the expiry — read the lock file to verify.
    await lock.refresh();
    const raw1 = await fs.readFile(lock.lockPath, "utf8");
    const payload1 = JSON.parse(raw1);

    await new Promise((r) => setTimeout(r, 50));
    await lock.refresh();
    const raw2 = await fs.readFile(lock.lockPath, "utf8");
    const payload2 = JSON.parse(raw2);

    // The second refresh should have a later expiresAt than the first.
    expect(Date.parse(payload2.expiresAt)).toBeGreaterThan(Date.parse(payload1.expiresAt));

    await lock.release();
  });
});
