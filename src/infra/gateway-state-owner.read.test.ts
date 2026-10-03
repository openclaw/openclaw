import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
  assertStateDatabaseReadAllowed,
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
