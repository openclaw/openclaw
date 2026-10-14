import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import * as snapshots from "../commands/config-preflight-snapshot.js";
import { withDoctorConfigPreflightHome } from "../commands/doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "../commands/startup-config-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  databasePortManifestPath,
  writeDatabasePortManifest,
  type DatabasePortRecoveryIntent,
} from "./database-port-recovery.js";
import { makeDatabasePortManifest } from "./database-port-recovery.test-support.js";
import { acquireEmbeddedStateLock } from "./embedded-state-lock.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "./gateway-lock.js";
import * as ownerLease from "./gateway-owner-lease.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Recovery publication requires POSIX permissions and directory fsync.
describe.skipIf(process.platform === "win32")("port recovery admission", () => {
  it("checks once at each admission and sees a port started after successful preflight", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          gateway: { mode: "local" },
          plugins: { enabled: false },
          meta: { migrations: { webhookListeners: true } },
        }),
      );
      openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
      closeOpenClawStateDatabaseForTest();
      const fixedPath = databasePortManifestPath(stateDir);
      const reads = vi.spyOn(fsSync, "readFileSync");
      const countReads = () => reads.mock.calls.filter(([file]) => file === fixedPath).length;
      expect(
        (await runStartupConfigPreflight({ gateway: true, observe: false })).snapshot.valid,
      ).toBe(true);
      expect(countReads()).toBe(1);
      const lock = await acquireGatewayLock({ allowInTests: true, timeoutMs: 0 });
      expect(lock).not.toBeNull();
      await lock?.release();
      expect(countReads()).toBe(2);
      writeDatabasePortManifest(stateDir, makeDatabasePortManifest(stateDir), () => {});
      const beforeNewAdmission = countReads();
      await expect(acquireGatewayLock({ allowInTests: true, timeoutMs: 0 })).rejects.toThrow(
        fixedPath,
      );
      expect(countReads() - beforeNewAdmission).toBe(1);
    });
  });

  async function fixture() {
    const stateDir = roots.make("openclaw-port-admission-");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(databasePath));
    await fs.writeFile(databasePath, "");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const manifest = makeDatabasePortManifest(stateDir);
    writeDatabasePortManifest(stateDir, manifest, () => {});
    const intent: DatabasePortRecoveryIntent = {
      manifestPath: databasePortManifestPath(stateDir),
      operationId: manifest.operationId,
      action: "resume",
    };
    return { stateDir, databasePath, manifest, intent };
  }

  it.each(["CLI preflight", "direct Gateway", "embedded writer"] as const)(
    "refuses a corrupt port manifest before %s inspects partial state",
    async (entry) => {
      const { databasePath, intent } = await fixture();
      await fs.writeFile(intent.manifestPath, "{broken");
      const reader = vi.spyOn(snapshots, "createConfigPreflightSnapshotReader");
      const lease = vi.spyOn(ownerLease, "assertGatewayOwnerLeaseStopped");
      const options = { allowInTests: true, timeoutMs: 0 };
      const attempt =
        entry === "CLI preflight"
          ? runStartupConfigPreflight({ gateway: true })
          : entry === "direct Gateway"
            ? acquireGatewayLock(options)
            : acquireEmbeddedStateLock({
                options: { ...options, timeoutMs: 1000 },
                formatActiveGatewayRefusal: () => "unexpected live Gateway",
              });
      await expect(attempt).rejects.toThrow(intent.manifestPath);
      await expect(attempt).rejects.toThrow("openclaw database port --resume");
      await expect(attempt).rejects.toThrow("openclaw database port --rollback");
      expect(reader).not.toHaveBeenCalled();
      expect(lease).not.toHaveBeenCalled();
      expect(await fs.readFile(databasePath)).toEqual(Buffer.alloc(0));
    },
  );

  it.each(["resume", "rollback"] as const)(
    "admits a manifest-bound %s without inspecting an interrupted zero-byte database",
    async (action) => {
      const { databasePath, intent } = await fixture();
      const lease = vi.spyOn(ownerLease, "assertGatewayOwnerLeaseStopped");
      const runLocal = vi.fn(async ({ assertCurrent }: { assertCurrent: () => void }) => {
        assertCurrent();
        return "recovery admitted";
      });
      await expect(
        runWithLocalStateOwner({
          method: "database.port",
          params: {},
          target: "synthetic workboard",
          databasePortRecovery: { ...intent, action },
          runLocal,
        }),
      ).resolves.toBe("recovery admitted");
      expect(runLocal).toHaveBeenCalledOnce();
      expect(lease).not.toHaveBeenCalled();
      expect(await fs.readFile(databasePath)).toEqual(Buffer.alloc(0));
    },
  );

  it.each(["operation", "root", "path"] as const)(
    "refuses a recovery intent bound to another %s",
    async (mismatch) => {
      const { intent, manifest } = await fixture();
      if (mismatch === "operation") {
        intent.operationId = randomUUID();
      } else if (mismatch === "path") {
        intent.manifestPath = path.join(path.dirname(intent.manifestPath), "other.json");
      } else {
        manifest.root.ino = String(BigInt(manifest.root.ino) + 1n);
        await fs.writeFile(intent.manifestPath, JSON.stringify(manifest));
      }
      const runLocal = vi.fn(async () => {});
      await expect(
        runWithLocalStateOwner({
          method: "database.port",
          params: {},
          target: "synthetic workboard",
          databasePortRecovery: intent,
          runLocal,
        }),
      ).rejects.toThrow("Database port recovery required");
      expect(runLocal).not.toHaveBeenCalled();
    },
  );

  it("keeps historical live-owner exclusion during recovery", async () => {
    const { intent, stateDir } = await fixture();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const paths = resolveGatewayLockPaths(env);
    await fs.mkdir(path.dirname(paths.configLockPath), { recursive: true });
    const record = JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath: paths.configPath,
      startTime: 123,
      role: "gateway",
    });
    await fs.writeFile(paths.configLockPath, record);
    await expect(
      acquireGatewayLock({
        env,
        role: "agent-embedded",
        allowInTests: true,
        timeoutMs: 0,
        databasePortRecovery: intent,
        readProcessStartTime: () => 123,
      }),
    ).rejects.toThrow("holder");
    expect(await fs.readFile(paths.configLockPath, "utf8")).toBe(record);
  });

  it("refuses hosted recovery before running either a local or foreign-owner callback", async () => {
    const { intent, manifest, stateDir } = await fixture();
    await fs.unlink(intent.manifestPath);
    const owner = await acquireGatewayLock({ allowInTests: true, timeoutMs: 0 });
    if (!owner) {
      throw new Error("Expected retained Gateway ownership");
    }
    writeDatabasePortManifest(stateDir, manifest, () => owner.assertCurrent());
    const runLocal = vi.fn(async () => {});
    const onForeignOwner = vi.fn(async () => {});
    try {
      await expect(
        runWithLocalStateOwner({
          method: "database.port",
          params: {},
          target: "synthetic workboard",
          databasePortRecovery: intent,
          onForeignOwner,
          runLocal,
        }),
      ).rejects.toThrow("exclusive offline ownership");
      expect(runLocal).not.toHaveBeenCalled();
      expect(onForeignOwner).not.toHaveBeenCalled();
    } finally {
      await owner.release();
    }
  });
});
