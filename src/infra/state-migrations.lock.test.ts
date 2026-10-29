import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function migrationOptions() {
  const stateDir = tempDirs.make("openclaw-state-migration-lock-");
  return {
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    stateDir,
    label: "legacy example state",
    releaseLabel: "Example",
  };
}

function lockOptions(env: NodeJS.ProcessEnv) {
  return { allowInTests: true, env, pollIntervalMs: 10, timeoutMs: 100 };
}

it.each([
  ["EACCES", "permission denied", "permissions"],
  ["ENOSYS", "function not implemented", "filesystem"],
  ["ENOSPC", "no space left on device", "space"],
  ["ENOTSUP", "operation not supported", "exclusive file creation"],
])("reports %s acquisition failure without inventing an owner", async (code, message, guidance) => {
  const options = migrationOptions();
  expect(fs.readdirSync(options.stateDir)).toEqual([]);
  const databasePath = path.join(options.stateDir, "state", "openclaw.sqlite");
  const ownerPath = resolveGatewayStateOwnerPath(databasePath);
  const open = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    if (file === ownerPath && typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
      throw Object.assign(new Error(message), { code });
    }
    return open(file, flags, mode);
  });
  const run = vi.fn(async () => ({ changes: ["imported"], warnings: [] }));
  const result = await withLegacyMigrationStateLock({ ...options, run });
  expect(result.changes).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  const warning = result.warnings.join("\n");
  for (const detail of [message, code, guidance]) {
    expect(warning).toContain(detail);
  }
  expect(warning).not.toContain("owns this state directory");
  expect(fs.readdirSync(path.dirname(ownerPath))).toEqual([]);
  expect(fs.existsSync(databasePath)).toBe(false);
});

it.each(["success", "converted", "thrown", "cleanup"] as const)(
  "releases ownership after %s",
  async (mode) => {
    const options = migrationOptions();
    const events: string[] = [];
    const message = "synthetic failure";
    const result = withLegacyMigrationStateLock({
      ...options,
      errorLabel: mode === "converted" ? "Migration failed" : undefined,
      beforeRelease: () => {
        events.push("nested-release");
        if (mode === "cleanup") {
          throw new Error(message);
        }
      },
      run: async (env) => {
        events.push("migrate");
        expect(env.OPENCLAW_STATE_DIR).toBe(options.stateDir);
        if (mode === "converted" || mode === "thrown") {
          throw new Error(message);
        }
        return {
          changes: ["imported"],
          warnings: ["retained source"],
          warningDisposition: "recoverable",
        };
      },
    });
    if (mode === "thrown") {
      await expect(result).rejects.toThrow(message);
    } else {
      const value = await result;
      expect(value.changes).toEqual(mode === "converted" ? [] : ["imported"]);
      expect(value.warnings).toEqual(
        mode === "converted"
          ? [`Migration failed: Error: ${message}`]
          : mode === "cleanup"
            ? ["retained source", `Example migration lock release failed: ${message}`]
            : ["retained source"],
      );
      expect(value.warningDisposition).toBe(mode === "success" ? "recoverable" : undefined);
    }
    expect(events).toEqual(["migrate", "nested-release"]);
    const lock = await acquireGatewayLock({
      ...lockOptions(options.env),
      role: "sqlite-maintenance",
    });
    expect(lock).not.toBeNull();
    await lock?.release();
  },
);

it("refuses active Gateway ownership without touching the migration source", async () => {
  const options = migrationOptions();
  const owner = await acquireGatewayLock({
    ...lockOptions(options.env),
    port: 18_796,
  });
  if (!owner) {
    throw new Error("expected Gateway lock");
  }
  onTestFinished(() => owner.release());
  const run = vi.fn(async () => ({ changes: [], warnings: [] }));
  const result = await withLegacyMigrationStateLock({
    ...options,
    retryGuidance: "Stop the Gateway and node host, then retry.",
    run,
  });
  expect(result.warnings).toEqual([expect.stringContaining("OpenClaw state database is busy")]);
  expect(result.warnings[0]).toContain("Stop the Gateway and node host, then retry.");
  expect(run).not.toHaveBeenCalled();
});
