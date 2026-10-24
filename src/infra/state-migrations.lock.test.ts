import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
  let injected = false;
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    if (file === ownerPath && typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
      injected = true;
      throw Object.assign(new Error(message), { code });
    }
    return open(file, flags, mode);
  });
  const run = vi.fn(async () => ({ changes: ["imported"], warnings: [] }));

  const result = await withLegacyMigrationStateLock({ ...options, run });

  expect(injected).toBe(true);
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
    const cleanup = mode === "cleanup";
    const success = mode === "success";
    const events: string[] = [];
    const message = cleanup ? "nested release failed" : "unsafe source";
    const retained = { changes: ["imported"], warnings: ["retained historical source"] };
    const result = withLegacyMigrationStateLock({
      ...options,
      errorLabel: mode === "converted" ? "Failed reading legacy example state" : undefined,
      beforeRelease:
        success || cleanup
          ? () => {
              events.push("nested-release");
              if (cleanup) {
                throw new Error(message);
              }
            }
          : undefined,
      run: async (env) => {
        events.push("migrate");
        expect(env.OPENCLAW_STATE_DIR).toBe(options.stateDir);
        if (!cleanup && !success) {
          throw new Error(message);
        }
        return {
          ...retained,
          warnings: cleanup ? [...retained.warnings] : [],
          ...(success ? { notices: ["verified"] } : { warningDisposition: "recoverable" as const }),
        };
      },
    });
    if (mode === "thrown") {
      await expect(result).rejects.toThrow(message);
    } else {
      await expect(result).resolves.toEqual({
        changes: cleanup || success ? ["imported"] : [],
        warnings: cleanup
          ? [...retained.warnings, `Example migration lock release failed: ${message}`]
          : success
            ? []
            : [`Failed reading legacy example state: Error: ${message}`],
        ...(success ? { notices: ["verified"] } : {}),
      });
    }
    if (success) {
      expect(events).toEqual(["migrate", "nested-release"]);
    }
    await expectStateOwnershipReleased(options.env);
  },
);

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

    expect(result.warnings).toEqual([expect.stringContaining("OpenClaw state database is busy")]);
    expect(result.warnings[0]).toContain("Stop the Gateway and node host, then retry.");
    expect(run).not.toHaveBeenCalled();
  } finally {
    await owner.release();
  }
});
