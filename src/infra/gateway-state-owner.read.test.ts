import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  GATEWAY_OWNER_HEARTBEAT_MS,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
} from "./gateway-lock-payload.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
  assertStateDatabaseReadAllowed,
  resolveGatewayStateOwnerPath,
} from "./gateway-state-owner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, "");
  return databasePath;
}

function acquireServingOwner(databasePath: string) {
  return acquireGatewayStateOwner({
    databasePath,
    payload: {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath: path.join(path.dirname(path.dirname(databasePath)), "openclaw.json"),
      role: "gateway",
    },
  });
}

function createAliasedDatabases() {
  const root = tempDirs.make("openclaw-owner-read-alias-");
  const original = path.join(root, "original");
  const replacement = path.join(root, "replacement");
  const alias = path.join(root, "alias");
  const originalDatabasePath = createDatabase(original);
  const replacementDatabasePath = createDatabase(replacement);
  fs.symlinkSync(original, alias, "junction");
  return {
    originalDatabasePath,
    replacementDatabasePath,
    databasePath: path.join(alias, "state", "openclaw.sqlite"),
    retarget() {
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement, alias, "junction");
    },
  };
}

describe("bounded Gateway state reads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([80_000, 91_000])(
    "keeps admission within persisted custody after a %i ms fsync delay",
    (delayMs) => {
      const databasePath = createDatabase(tempDirs.make("openclaw-owner-heartbeat-admission-"));
      const ownerPath = resolveGatewayStateOwnerPath(databasePath);
      const epoch = Date.parse("2026-01-01T00:00:00Z");
      const timersBefore = vi.getTimerCount();
      vi.setSystemTime(epoch);
      const fsync = fs.fsyncSync.bind(fs);
      const delayedFsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce((fd) => {
        fsync(fd);
        fs.futimesSync(fd, new Date(epoch), new Date(epoch));
        vi.setSystemTime(epoch + delayMs);
      });
      let owner: ReturnType<typeof acquireServingOwner> | undefined;
      try {
        if (delayMs > GATEWAY_OWNER_HEARTBEAT_STALE_MS) {
          expect(() => {
            owner = acquireServingOwner(databasePath);
          }).toThrow("no longer current");
        } else {
          const acquired = (owner = acquireServingOwner(databasePath));
          expect(fs.statSync(ownerPath).mtimeMs).toBe(epoch + delayMs);
          expect(() => acquired.assertCurrent()).not.toThrow();
          vi.advanceTimersByTime(GATEWAY_OWNER_HEARTBEAT_MS);
          expect(() => acquired.assertCurrent()).not.toThrow();
          expect(fs.statSync(ownerPath).mtimeMs).toBe(epoch + delayMs + GATEWAY_OWNER_HEARTBEAT_MS);
        }
      } finally {
        owner?.release();
        delayedFsync.mockRestore();
      }
      expect(fs.existsSync(ownerPath)).toBe(false);
      expect(vi.getTimerCount()).toBe(timersBefore);
    },
  );

  it("renews immutable owner and projection files until the final retained schema lease ends", async () => {
    const root = tempDirs.make("openclaw-owner-heartbeat-");
    const databasePath = createDatabase(root);
    const timersBefore = vi.getTimerCount();
    const gateway = await acquireGatewayLock({
      allowInTests: true,
      env: { OPENCLAW_STATE_DIR: root },
      timeoutMs: 0,
      readProcessStartTime: () => null,
    });
    if (!gateway) {
      throw new Error("Expected Gateway ownership");
    }
    const schema = acquireStateDatabaseSchemaLease(databasePath);
    const files = [gateway.lockPath, gateway.stateLockPath].map((lockPath) => ({
      lockPath,
      raw: fs.readFileSync(lockPath, "utf8"),
      mtime: fs.statSync(lockPath).mtimeMs,
    }));
    try {
      for (let tick = 0; tick < 3; tick += 1) {
        vi.advanceTimersByTime(GATEWAY_OWNER_HEARTBEAT_MS);
        expect(() => gateway.assertCurrent()).not.toThrow();
        expect(() => schema.assertCurrent()).not.toThrow();
        for (const file of files) {
          expect(fs.readFileSync(file.lockPath, "utf8")).toBe(file.raw);
          const mtime = fs.statSync(file.lockPath).mtimeMs;
          expect(mtime).toBeGreaterThan(file.mtime);
          file.mtime = mtime;
        }
      }
      await gateway.release();
      vi.advanceTimersByTime(GATEWAY_OWNER_HEARTBEAT_MS);
      expect(() => schema.assertCurrent()).not.toThrow();
      for (const file of files) {
        expect(fs.readFileSync(file.lockPath, "utf8")).toBe(file.raw);
        expect(fs.statSync(file.lockPath).mtimeMs).toBeGreaterThan(file.mtime);
      }
      schema.release();
      expect(vi.getTimerCount()).toBe(timersBefore);
      for (const file of files) {
        expect(fs.existsSync(file.lockPath)).toBe(false);
      }
    } finally {
      schema.release();
      await gateway.release();
    }
  });

  it.each(["authority check", "delayed heartbeat"] as const)(
    "irrevocably fences expired ownership when observed by %s",
    (observation) => {
      const databasePath = createDatabase(tempDirs.make("openclaw-owner-heartbeat-expired-"));
      const owner = acquireServingOwner(databasePath);
      const startedAt = Date.now();
      const mtime = fs.statSync(owner.path).mtimeMs;
      try {
        vi.setSystemTime(startedAt + GATEWAY_OWNER_HEARTBEAT_STALE_MS + 1);
        if (observation === "authority check") {
          expect(() => owner.assertCurrent()).toThrow("no longer current");
        }
        vi.advanceTimersByTime(GATEWAY_OWNER_HEARTBEAT_MS);
        expect(() => owner.assertCurrent()).toThrow("no longer current");
        expect(fs.statSync(owner.path).mtimeMs).toBe(mtime);
        vi.setSystemTime(startedAt);
        vi.advanceTimersByTime(GATEWAY_OWNER_HEARTBEAT_MS);
        expect(() => owner.assertCurrent()).toThrow("no longer current");
        expect(fs.statSync(owner.path).mtimeMs).toBe(mtime);
      } finally {
        owner.release();
      }
    },
  );

  it.each(["owner", "projection"] as const)(
    "rechecks a replaced %s when the read verification window expires",
    async (kind) => {
      const root = tempDirs.make("openclaw-owner-read-replaced-");
      const databasePath = createDatabase(root);
      const gateway = await acquireGatewayLock({
        allowInTests: true,
        env: { OPENCLAW_STATE_DIR: root },
        timeoutMs: 0,
        readProcessStartTime: () => null,
      });
      if (!gateway) {
        throw new Error("Expected Gateway ownership");
      }
      const replacedPath = kind === "owner" ? gateway.lockPath : gateway.stateLockPath;
      try {
        assertStateDatabaseReadAllowed(databasePath);
        fs.unlinkSync(replacedPath);
        fs.writeFileSync(replacedPath, "replacement");
        const replacementMtime = fs.statSync(replacedPath).mtimeMs;
        expect(() => assertStateDatabaseReadAllowed(databasePath)).not.toThrow();
        vi.advanceTimersByTime(999);
        expect(() => assertStateDatabaseReadAllowed(databasePath)).not.toThrow();
        vi.advanceTimersByTime(1);
        expect(() => assertStateDatabaseReadAllowed(databasePath)).toThrow("could not be verified");
        expect(() =>
          kind === "owner"
            ? assertStateDatabaseAccessAllowed(databasePath)
            : gateway.assertCurrent(),
        ).toThrow(kind === "owner" ? "could not be verified" : "no longer current");
        vi.advanceTimersByTime(GATEWAY_OWNER_HEARTBEAT_MS);
        expect(fs.statSync(replacedPath).mtimeMs).toBe(replacementMtime);
      } finally {
        await gateway.release();
      }
      expect(fs.readFileSync(replacedPath, "utf8")).toBe("replacement");
    },
  );

  it("observes an alias retarget immediately for strict access and at expiry for reads", () => {
    const fixture = createAliasedDatabases();
    const owner = acquireServingOwner(fixture.originalDatabasePath);
    const maintenance = acquireGatewayStateOwner({ databasePath: fixture.replacementDatabasePath });
    try {
      assertStateDatabaseReadAllowed(fixture.databasePath);
      fixture.retarget();
      expect(() => assertStateDatabaseAccessAllowed(fixture.databasePath)).toThrow(
        "offline maintenance",
      );
      expect(() => owner.assertDatabaseAccess(fixture.databasePath)).toThrow(
        "does not own this database",
      );
      vi.advanceTimersByTime(999);
      expect(() => assertStateDatabaseReadAllowed(fixture.databasePath)).not.toThrow();
      vi.advanceTimersByTime(1);
      expect(() => assertStateDatabaseReadAllowed(fixture.databasePath)).toThrow(
        "offline maintenance",
      );
    } finally {
      maintenance.release();
      owner.release();
    }
  });

  it.each(["schema acquisition", "schema release", "root release", "failed cleanup"] as const)(
    "invalidates a cached alias resolution on %s without waiting for expiry",
    (transition) => {
      const fixture = createAliasedDatabases();
      const owner = acquireServingOwner(fixture.originalDatabasePath);
      const maintenance = acquireGatewayStateOwner({
        databasePath: fixture.replacementDatabasePath,
      });
      let schema: ReturnType<typeof acquireStateDatabaseSchemaLease> | undefined;
      try {
        if (transition === "schema release") {
          schema = acquireStateDatabaseSchemaLease(fixture.originalDatabasePath);
        }
        assertStateDatabaseReadAllowed(fixture.databasePath);
        fixture.retarget();
        expect(() => assertStateDatabaseReadAllowed(fixture.databasePath)).not.toThrow();
        if (transition === "schema acquisition") {
          schema = acquireStateDatabaseSchemaLease(fixture.originalDatabasePath);
        } else if (transition === "schema release") {
          schema?.release();
        } else if (transition === "root release") {
          owner.release();
        } else {
          const remove = fs.rmSync.bind(fs);
          const failure = new Error("controlled ownership cleanup failure");
          const cleanup = vi.spyOn(fs, "rmSync").mockImplementation((pathname, options) => {
            if (pathname === owner.path) {
              throw failure;
            }
            remove(pathname, options);
          });
          try {
            expect(() => owner.release()).toThrow(failure);
          } finally {
            cleanup.mockRestore();
          }
        }
        expect(() => assertStateDatabaseReadAllowed(fixture.databasePath)).toThrow(
          "offline maintenance",
        );
      } finally {
        schema?.release();
        maintenance.release();
        owner.release();
      }
    },
  );

  it("does not resolve or open ownership paths for warmed reads within the verification window", () => {
    const databasePath = createDatabase(tempDirs.make("openclaw-owner-read-syscalls-"));
    const owner = acquireServingOwner(databasePath);
    try {
      assertStateDatabaseReadAllowed(databasePath);
      const realpath = vi.spyOn(fs.realpathSync, "native");
      const open = vi.spyOn(fs, "openSync");
      try {
        for (let index = 0; index < 20; index += 1) {
          assertStateDatabaseReadAllowed(databasePath);
        }
        expect(realpath).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      } finally {
        realpath.mockRestore();
        open.mockRestore();
      }
    } finally {
      owner.release();
    }
  });
});
