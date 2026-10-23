import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { inspectGatewayLockRecovery, recoverGatewayLock } from "./gateway-lock-recovery.js";
import { resolveGatewayLockPaths } from "./gateway-lock.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const root = tempDirs.make("gateway-lock-recovery-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  const env = process.env;
  const paths = resolveGatewayLockPaths(env);
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  const localNamespace = readGatewayLockProcessNamespace();
  if (!localNamespace) {
    throw new Error("Recovery fixture requires the local process namespace");
  }
  const payload = {
    ...defaultPayload(databasePath),
    processNamespace: {
      ...localNamespace,
      host: "stopped-foreign-container",
      identity: "d14120e1-94fd-498b-92b7-e323f75da593",
    },
  };
  fs.mkdirSync(path.dirname(paths.ownerLockPath), { recursive: true });
  const lockPaths = [paths.ownerLockPath, paths.stateLockPath, paths.configLockPath];
  for (const pathname of lockPaths) {
    fs.writeFileSync(pathname, JSON.stringify(payload));
  }
  return { env, paths, databasePath, payload, lockPaths };
}

describe("explicit Gateway lock recovery", () => {
  it("inspects without changing files and removes only the confirmed foreign owner", async () => {
    const { env, lockPaths } = fixture();
    const before = lockPaths.map((pathname) => fs.statSync(pathname, { bigint: true }));
    const inspection = await inspectGatewayLockRecovery({ env });
    expect(inspection.holders).toHaveLength(3);
    expect(inspection.holders.join("\n")).toContain("stopped-foreign-container");
    expect(lockPaths.map((pathname) => fs.statSync(pathname, { bigint: true }).mtimeNs)).toEqual(
      before.map((stat) => stat.mtimeNs),
    );
    await expect(
      recoverGatewayLock({ confirmation: inspection.confirmation }),
    ).resolves.toMatchObject({ recovered: true, removed: 3 });
    expect(lockPaths.map((pathname) => fs.existsSync(pathname))).toEqual([false, false, false]);
  });

  it.each(["replacement", "heartbeat", "payload"])(
    "refuses an owner %s after inspection",
    async (change) => {
      const { env, paths } = fixture();
      const inspection = await inspectGatewayLockRecovery({ env });
      const original = fs.readFileSync(paths.ownerLockPath, "utf8");
      if (change === "replacement") {
        fs.renameSync(paths.ownerLockPath, `${paths.ownerLockPath}.old`);
        fs.writeFileSync(paths.ownerLockPath, original);
      } else if (change === "payload") {
        fs.writeFileSync(
          paths.ownerLockPath,
          original.replace("stopped-foreign-container", "changed-foreign-container"),
        );
      } else {
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(paths.ownerLockPath, future, future);
      }
      await expect(recoverGatewayLock({ confirmation: inspection.confirmation })).rejects.toThrow(
        "changed since inspection",
      );
      expect(fs.existsSync(paths.ownerLockPath)).toBe(true);
    },
  );

  it("refuses an in-place rewrite even when the original bytes and mtime are restored", async () => {
    const { env, paths } = fixture();
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    fs.utimesSync(paths.ownerLockPath, stamp, stamp);
    const original = fs.readFileSync(paths.ownerLockPath, "utf8");
    const identity = fs.statSync(paths.ownerLockPath, { bigint: true });
    let ctime = identity.ctimeNs;
    const fstat = fs.fstatSync;
    // Model separate timestamp ticks without depending on kernel ctime granularity.
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      if (!args[1]?.bigint) {
        return fstat(...args);
      }
      const result = fstat(args[0], { bigint: true });
      if (result.dev === identity.dev && result.ino === identity.ino) {
        Object.defineProperty(result, "ctimeNs", { value: ctime });
      }
      return result;
    });
    const inspection = await inspectGatewayLockRecovery({ env });
    fs.writeFileSync(paths.ownerLockPath, "changed");
    fs.writeFileSync(paths.ownerLockPath, original);
    fs.utimesSync(paths.ownerLockPath, stamp, stamp);
    ctime += 1_000_000n;
    await expect(recoverGatewayLock({ confirmation: inspection.confirmation })).rejects.toThrow(
      "changed since inspection",
    );
    expect(fs.readFileSync(paths.ownerLockPath, "utf8")).toBe(original);
  });

  it("does not create lock files when inspection finds no owner", async () => {
    const { env, lockPaths } = fixture();
    for (const pathname of lockPaths) {
      fs.unlinkSync(pathname);
    }
    const inspection = await inspectGatewayLockRecovery({ env });
    await expect(recoverGatewayLock({ confirmation: inspection.confirmation })).resolves.toEqual({
      recovered: false,
      removed: 0,
    });
    expect(lockPaths.every((pathname) => !fs.existsSync(pathname))).toBe(true);
  });

  it("refuses a verified live local holder even with its confirmation", async () => {
    const { env, databasePath, lockPaths } = fixture();
    const payload = defaultPayload(databasePath);
    for (const pathname of lockPaths) {
      fs.writeFileSync(pathname, JSON.stringify(payload));
    }
    const inspection = await inspectGatewayLockRecovery({ env });
    await expect(recoverGatewayLock({ confirmation: inspection.confirmation })).rejects.toThrow(
      "still live",
    );
    expect(lockPaths.every((pathname) => fs.existsSync(pathname))).toBe(true);
  });

  it("clears the matching SQLite lease while retaining physical custody", async () => {
    const { env, databasePath, payload, lockPaths } = fixture();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = openNodeSqliteDatabase(databasePath);
    db.exec(
      "CREATE TABLE state_leases (scope TEXT, lease_key TEXT, owner TEXT, created_at INTEGER, expires_at INTEGER, heartbeat_at INTEGER, payload_json TEXT)",
    );
    db.prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "gateway-owner",
      "global",
      "old-gateway",
      1,
      2,
      1,
      JSON.stringify({
        owner: {
          pid: payload.pid,
          host: "stopped-foreign-container",
          startedAt: payload.startTime ?? null,
          processNamespace: payload.processNamespace,
        },
        port: 18789,
        mode: "foreground",
        supervisor: null,
      }),
    );
    db.close();
    const inspection = await inspectGatewayLockRecovery({ env });
    expect(inspection.lease?.owner).toBe("old-gateway");
    await recoverGatewayLock({ confirmation: inspection.confirmation });
    const verified = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(verified.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toMatchObject({
        count: 0,
      });
    } finally {
      verified.close();
    }
    expect(lockPaths.every((pathname) => !fs.existsSync(pathname))).toBe(true);
  });
});
