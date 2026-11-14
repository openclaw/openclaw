import { randomUUID } from "node:crypto";
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
import * as gatewayLockProcessModule from "./gateway-lock-process.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "./gateway-lock.js";
import * as ownerLease from "./gateway-owner-lease.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const lockOptions = { allowInTests: true, timeoutMs: 0 };

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Recovery publication requires POSIX permissions and directory fsync.
describe.skipIf(process.platform === "win32")("port recovery admission", () => {
  it("sees a port started after successful preflight and prior admission", async () => {
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
      expect(
        (await runStartupConfigPreflight({ gateway: true, observe: false })).snapshot.valid,
      ).toBe(true);
      const lock = await acquireGatewayLock(lockOptions);
      expect(lock).not.toBeNull();
      await lock?.release();
      writeDatabasePortManifest(stateDir, makeDatabasePortManifest(stateDir), () => {});
      await expect(acquireGatewayLock(lockOptions)).rejects.toThrow(fixedPath);
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
    const lease = vi.spyOn(ownerLease, "assertGatewayOwnerLeaseStopped");
    const runLocal = vi.fn(async ({ assertCurrent }: { assertCurrent: () => void }) => {
      assertCurrent();
      return "recovery admitted";
    });
    const onForeignOwner = vi.fn(async () => "foreign owner");
    const recover = (withForeignOwner = false) =>
      runWithLocalStateOwner({
        method: "database.port",
        params: {},
        target: "synthetic workboard",
        databasePortRecovery: intent,
        runLocal,
        ...(withForeignOwner ? { onForeignOwner } : {}),
      });
    return { stateDir, databasePath, manifest, intent, lease, runLocal, onForeignOwner, recover };
  }

  it.each(["CLI preflight", "direct Gateway", "embedded writer"] as const)(
    "refuses a corrupt port manifest before %s inspects partial state",
    async (entry) => {
      const { databasePath, intent, lease } = await fixture();
      await fs.writeFile(intent.manifestPath, "{broken");
      const reader = vi.spyOn(snapshots, "createConfigPreflightSnapshotReader");
      const attempt =
        entry === "CLI preflight"
          ? runStartupConfigPreflight({ gateway: true })
          : entry === "direct Gateway"
            ? acquireGatewayLock(lockOptions)
            : acquireEmbeddedStateLock({
                options: { ...lockOptions, timeoutMs: 1000 },
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

  it.each(["resume", "rollback", "operation", "root", "path"] as const)(
    "checks recovery identity before touching partial state: %s",
    async (scenario) => {
      const { databasePath, intent, manifest, lease, runLocal, recover } = await fixture();
      const admitted = scenario === "resume" || scenario === "rollback";
      if (scenario === "resume" || scenario === "rollback") {
        intent.action = scenario;
      } else if (scenario === "operation") {
        intent.operationId = randomUUID();
      } else if (scenario === "path") {
        intent.manifestPath = path.join(path.dirname(intent.manifestPath), "other.json");
      } else {
        manifest.root.ino = String(BigInt(manifest.root.ino) + 1n);
        await fs.writeFile(intent.manifestPath, JSON.stringify(manifest));
      }
      if (admitted) {
        await expect(recover()).resolves.toBe("recovery admitted");
        expect(runLocal).toHaveBeenCalledOnce();
        expect(lease).not.toHaveBeenCalled();
        expect(await fs.readFile(databasePath)).toEqual(Buffer.alloc(0));
      } else {
        await expect(recover()).rejects.toThrow("Database port recovery required");
        expect(runLocal).not.toHaveBeenCalled();
      }
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
    vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockImplementation(
      () => 123,
    );
    await expect(
      acquireGatewayLock({
        env,
        role: "agent-embedded",
        ...lockOptions,
        databasePortRecovery: intent,
      }),
    ).rejects.toThrow("holder");
    expect(await fs.readFile(paths.configLockPath, "utf8")).toBe(record);
  });

  it("refuses hosted recovery before running either a local or foreign-owner callback", async () => {
    const { intent, manifest, stateDir, runLocal, onForeignOwner, recover } = await fixture();
    await fs.unlink(intent.manifestPath);
    const owner = await acquireGatewayLock(lockOptions);
    if (!owner) {
      throw new Error("Expected retained Gateway ownership");
    }
    writeDatabasePortManifest(stateDir, manifest, () => owner.assertCurrent());
    try {
      await expect(recover(true)).rejects.toThrow("exclusive offline ownership");
      expect(runLocal).not.toHaveBeenCalled();
      expect(onForeignOwner).not.toHaveBeenCalled();
    } finally {
      await owner.release();
    }
  });
});
