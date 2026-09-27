import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import * as nodeSqlite from "./node-sqlite.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";

describe("legacy state migration ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function migrationOptions() {
    const stateDir = tempDirs.make("openclaw-state-migration-lock-");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    };
    return {
      env,
      stateDir,
      label: "legacy example state",
      releaseLabel: "Example",
    };
  }

  async function expectStateOwnershipReleased(env: NodeJS.ProcessEnv) {
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      role: "sqlite-maintenance",
      timeoutMs: 100,
    });
    expect(lock).not.toBeNull();
    await lock?.release();
  }

  it.each([
    { code: "EACCES", message: "permission denied", guidance: "permissions" },
    { code: "ENOSYS", message: "function not implemented", guidance: "filesystem" },
    { code: "ENOSPC", message: "no space left on device", guidance: "space" },
    {
      code: "ERR_SQLITE_ERROR",
      errcode: 3850,
      message: "disk I/O error",
      guidance: "SQLite locking",
    },
  ])(
    "reports $code acquisition failure on empty state without inventing an owner",
    async (failure) => {
      const options = migrationOptions();
      expect(fs.readdirSync(options.stateDir)).toEqual([]);
      const open = nodeSqlite.openNodeSqliteDatabase;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementationOnce((...args) => {
        const database = open(...args);
        const exec = database.exec.bind(database);
        vi.spyOn(database, "exec").mockImplementation((sql) => {
          if (sql.includes("BEGIN EXCLUSIVE")) {
            throw Object.assign(new Error(failure.message), {
              code: failure.code,
              ...("errcode" in failure ? { errcode: failure.errcode } : {}),
            });
          }
          exec(sql);
        });
        return database;
      });
      const run = vi.fn(async () => ({ changes: ["imported"], warnings: [] }));

      const result = await withLegacyMigrationStateLock({ ...options, run });

      expect(result.changes).toEqual([]);
      expect(run).not.toHaveBeenCalled();
      const warning = result.warnings.join("\n");
      expect(warning).toContain(failure.message);
      expect(warning).toContain(failure.code);
      expect(warning).toContain(failure.guidance);
      if ("errcode" in failure) {
        expect(warning).toContain("3850");
      }
      expect(warning).not.toContain("owns this state directory");
      expect(fs.readdirSync(options.stateDir)).toEqual([]);
    },
  );

  it("keeps nested cleanup inside exclusive ownership and forwards canonical state env", async () => {
    const options = migrationOptions();
    const events: string[] = [];
    const result = await withLegacyMigrationStateLock({
      ...options,
      beforeRelease: () => {
        events.push("nested-release");
      },
      run: async (env) => {
        events.push("migrate");
        expect(env.OPENCLAW_STATE_DIR).toBe(options.stateDir);
        return { changes: ["imported"], warnings: [], notices: ["verified"] };
      },
    });

    expect(result).toEqual({ changes: ["imported"], warnings: [], notices: ["verified"] });
    expect(events).toEqual(["migrate", "nested-release"]);
    await expectStateOwnershipReleased(options.env);
  });

  it("reports migration failures without retaining exclusive ownership", async () => {
    const options = migrationOptions();
    const result = await withLegacyMigrationStateLock({
      ...options,
      errorLabel: "Failed reading legacy example state",
      run: async () => {
        throw new Error("unsafe source");
      },
    });

    expect(result).toEqual({
      changes: [],
      warnings: ["Failed reading legacy example state: Error: unsafe source"],
    });
    await expectStateOwnershipReleased(options.env);
  });

  it("preserves thrown owner failures when the caller does not request conversion", async () => {
    const options = migrationOptions();
    await expect(
      withLegacyMigrationStateLock({
        ...options,
        run: async () => {
          throw new Error("unexpected owner failure");
        },
      }),
    ).rejects.toThrow("unexpected owner failure");
    await expectStateOwnershipReleased(options.env);
  });

  it("reports nested cleanup failures after releasing the Gateway lock", async () => {
    const options = migrationOptions();
    const result = await withLegacyMigrationStateLock({
      ...options,
      beforeRelease: () => {
        throw new Error("nested release failed");
      },
      run: async () => ({
        changes: ["imported"],
        warnings: ["retained historical source"],
        warningDisposition: "recoverable",
      }),
    });

    expect(result).toEqual({
      changes: ["imported"],
      warnings: [
        "retained historical source",
        "Example migration lock release failed: nested release failed",
      ],
    });
    await expectStateOwnershipReleased(options.env);
  });

  it("refuses active Gateway ownership without touching the migration source", async () => {
    const options = migrationOptions();
    const owner = await acquireGatewayLock({
      allowInTests: true,
      env: options.env,
      pollIntervalMs: 10,
      port: 18_796,
      timeoutMs: 100,
    });
    if (!owner) {
      throw new Error("expected Gateway lock");
    }
    const run = vi.fn(async () => ({ changes: [], warnings: [] }));
    try {
      const result = await withLegacyMigrationStateLock({
        ...options,
        retryGuidance: "Stop the Gateway and node host, then retry.",
        run,
      });

      expect(result.warnings).toEqual([expect.stringContaining("gateway already running")]);
      expect(result.warnings[0]).toContain("Stop the Gateway and node host, then retry.");
      expect(run).not.toHaveBeenCalled();
    } finally {
      await owner.release();
    }
  });
});
