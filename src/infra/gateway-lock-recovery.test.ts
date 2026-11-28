import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { addGatewayLockRecoveryCommand } from "../cli/gateway-cli/register-recover-lock.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import { defaultRuntime } from "../runtime.js";
import * as processIdentity from "../shared/pid-alive.js";
import {
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  parseGatewayLockPayload,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { inspectGatewayLockRecovery, recoverGatewayLock } from "./gateway-lock-recovery.js";
import { resolveGatewayLockPaths } from "./gateway-lock.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixturePaths() {
  const root = tempDirs.make("gateway-lock-recovery-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  const env = process.env;
  const paths = resolveGatewayLockPaths(env);
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  return { env, paths, databasePath };
}

function fixture() {
  const { env, paths, databasePath } = fixturePaths();
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
  const lockPaths = [paths.ownerLockPath, paths.stateLockPath, paths.configLockPath];
  for (const pathname of lockPaths) {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, JSON.stringify(payload));
  }
  return { env, paths, databasePath, payload, lockPaths };
}

describe("explicit Gateway lock recovery", () => {
  it.skipIf(process.platform !== "linux")(
    "recovers a foreign stopped Doctor maintenance instance through the Gateway command",
    async () => {
      const { env, paths } = fixturePaths();
      const lockPaths = [paths.ownerLockPath, paths.stateLockPath];
      const records = await withDoctorSqliteMaintenanceLock({
        env,
        operation: "test maintenance",
        run: () =>
          lockPaths.map((pathname) => {
            const payload = parseGatewayLockPayload(fs.readFileSync(pathname, "utf8"));
            if (!payload) {
              throw new Error(`Maintenance lock has an invalid payload: ${pathname}`);
            }
            return { pathname, payload };
          }),
      });
      const local = readGatewayLockProcessNamespace();
      const pidNsInitStartTicks = processIdentity.getProcessStartTime(1);
      if (local?.platform !== "linux" || pidNsInitStartTicks === null) {
        throw new Error("Linux PID namespace identity required");
      }
      const placement = {
        ...local,
        host: "stopped-foreign-container",
        pidNsInode: local.pidNsInode === "12345" ? "12346" : "12345",
      };
      // Retain the actual maintenance writer's records and witness; select only
      // the foreign namespace fixture to model files left after it stopped.
      for (const record of records) {
        fs.writeFileSync(
          record.pathname,
          JSON.stringify({ ...record.payload, processNamespace: placement }),
        );
      }
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const program = new Command();
      program.exitOverride();
      addGatewayLockRecoveryCommand(program.command("gateway"));
      await program.parseAsync(
        [
          "gateway",
          "recover-lock",
          "--terminated-namespace",
          JSON.stringify({ ...placement, pidNsInitStartTicks }),
          "--json",
        ],
        { from: "user" },
      );
      expect(output).toHaveBeenCalledWith({ recovered: true, removed: records.length });
      expect(records.every((record) => !fs.existsSync(record.pathname))).toBe(true);
    },
  );

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

  it.each(["dead", "live", "unknown"] as const)(
    "handles a %s legacy Windows owner during confirmed recovery",
    async (status) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const { env, payload, lockPaths } = fixture();
      vi.spyOn(processIdentity, "isPidAlive").mockReturnValue(status === "live");
      vi.spyOn(processIdentity, "isPidDefinitelyDead").mockReturnValue(status === "dead");
      vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(null);
      for (const pathname of lockPaths) {
        fs.writeFileSync(
          pathname,
          JSON.stringify({ ...payload, pid: 2_147_483_647, processNamespace: undefined }),
        );
        const expired = new Date(Date.now() - GATEWAY_OWNER_HEARTBEAT_STALE_MS - 1000);
        fs.utimesSync(pathname, expired, expired);
      }
      const inspection = await inspectGatewayLockRecovery({ env });
      const recovery = recoverGatewayLock({ confirmation: inspection.confirmation });
      if (status === "dead") {
        await expect(recovery).resolves.toMatchObject({ recovered: true, removed: 3 });
        expect(lockPaths.every((pathname) => !fs.existsSync(pathname))).toBe(true);
      } else {
        await expect(recovery).rejects.toThrow("stop it before recovering");
        expect(lockPaths.every((pathname) => fs.existsSync(pathname))).toBe(true);
      }
    },
  );

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

  it
    .skipIf(process.platform !== "linux")
    .each(["matching", "different file", "missing incarnation"] as const)(
    "recovers only files from the verified foreign Gateway instance (%s)",
    async (kind) => {
      const { payload, paths, lockPaths } = fixture();
      const namespace = {
        ...payload.processNamespace,
        pidNsInode: "12345",
        pidNsInitStartTicks: 7,
      };
      for (const pathname of lockPaths) {
        fs.writeFileSync(
          pathname,
          JSON.stringify({
            ...payload,
            role: "gateway",
            processNamespace: { ...payload.processNamespace, pidNsInode: namespace.pidNsInode },
            pidNsInitStartTicks: kind === "missing incarnation" ? undefined : 7,
          }),
        );
      }
      if (kind === "different file") {
        fs.writeFileSync(paths.configLockPath, JSON.stringify(payload));
      }
      const recovery = recoverGatewayLock({ terminatedNamespace: namespace });
      if (kind === "matching") {
        await expect(recovery).resolves.toEqual({ recovered: true, removed: 3 });
      } else {
        await expect(recovery).rejects.toThrow("does not belong");
      }
      expect(lockPaths.every((pathname) => fs.existsSync(pathname) === (kind !== "matching"))).toBe(
        true,
      );
    },
  );

  it.skipIf(process.platform !== "linux").each(["gateway", "sqlite-maintenance"] as const)(
    "checks the live %s PID when another hostname uses the caller's PID namespace",
    async (role) => {
      const { payload, lockPaths } = fixture();
      const local = readGatewayLockProcessNamespace();
      if (local?.platform !== "linux") {
        throw new Error("Linux PID namespace required");
      }
      const placement = { ...local, host: "previous-container" };
      const proof = { ...placement, pidNsInitStartTicks: processIdentity.getProcessStartTime(1) };
      const record = {
        ...payload,
        role,
        processNamespace: placement,
        pidNsInitStartTicks: role === "gateway" ? proof.pidNsInitStartTicks : undefined,
      };
      for (const pathname of lockPaths) {
        fs.writeFileSync(pathname, JSON.stringify(record));
      }
      await expect(recoverGatewayLock({ terminatedNamespace: proof })).rejects.toThrow(
        "Cannot verify that PID",
      );
      expect(lockPaths.every((pathname) => fs.existsSync(pathname))).toBe(true);
      for (const pathname of lockPaths) {
        fs.writeFileSync(pathname, JSON.stringify({ ...record, pid: 2_147_483_647 }));
      }
      await expect(recoverGatewayLock({ terminatedNamespace: proof })).resolves.toEqual({
        recovered: true,
        removed: 3,
      });
    },
  );

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
          // Pre-namespace releases persisted the owner without processNamespace.
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
