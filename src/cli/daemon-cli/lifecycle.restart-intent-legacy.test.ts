import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveGatewayLockPaths } from "../../infra/gateway-lock.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import * as existingWrites from "../../state/openclaw-state-db-existing-write.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createGatewayServiceRunArgs,
  lifecycleTestRuntime,
  lifecycleRuntimeLogs,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
} from "./test-helpers/lifecycle-core-harness.js";

vi.mock("../../runtime.js", () => ({ defaultRuntime: lifecycleTestRuntime }));
vi.mock("./lifecycle-action-preflight.js", () => ({
  getServiceActionPreflightFailure: async () => null,
}));
vi.mock("./lifecycle-audit.js", () => ({
  createServiceLifecycleMutationAudit: () => undefined,
  appendServiceLifecycleRepairAudit: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { runServiceRestart } = await import("./lifecycle-core.js");
const packageRoot = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
if (!packageRoot) {
  throw new Error("Legacy restart fixture requires this checkout's package root");
}

type LegacyLock = {
  pid: number;
  startTime?: number;
  ownerId: string;
  createdAt: string;
  configPath: string;
  stateDir: string;
  port: number;
};

const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = [];

async function spawnServingChild(): Promise<LegacyLock> {
  const child = spawn(
    process.execPath,
    ["-e", "process.title='openclaw-gateway';process.send('ready');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  children.push({ child, exited: once(child, "exit") });
  await once(child, "message");
  if (!child.pid) {
    throw new Error("Legacy serving child did not start");
  }
  const startTime = getFileLockProcessStartTime(child.pid);
  if (startTime === null) {
    throw new Error("Legacy serving child start identity is unavailable");
  }
  const paths = resolveGatewayLockPaths(process.env);
  return {
    pid: child.pid,
    startTime,
    ownerId: `legacy-gateway-${child.pid}`,
    createdAt: new Date().toISOString(),
    configPath: paths.configPath,
    stateDir: paths.stateDir,
    port: 18789,
  };
}

async function stopServingChild(pid: number) {
  const owned = children.find(({ child }) => child.pid === pid);
  if (!owned) {
    throw new Error("Legacy serving child is not owned by this test");
  }
  owned.child.kill("SIGTERM");
  await owned.exited;
}

function writeLegacyLock(lock: LegacyLock) {
  const { stateLockPath } = resolveGatewayLockPaths(process.env);
  fs.mkdirSync(path.dirname(stateLockPath), { recursive: true });
  fs.writeFileSync(stateLockPath, JSON.stringify(lock));
}

function beforeIntentWriteAdmission(operation: () => void) {
  const write = existingWrites.runExistingOpenClawStateWriteTransaction;
  vi.spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction").mockImplementation(
    (mutate, options, contract) => {
      if (contract.operationLabel === "gateway.restart-intent.write") {
        operation();
      }
      return write(mutate, options, contract);
    },
  );
}

function publishUnrelatedOwner(pid = process.pid) {
  const now = Date.now();
  openOpenClawStateDatabase()
    .db.prepare(
      `INSERT INTO state_leases
       (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
       VALUES ('gateway-owner', 'global', 'unrelated-owner', ?, ?, ?, ?, ?)`,
    )
    .run(
      now + 60_000,
      now,
      JSON.stringify({
        owner: {
          pid,
          host: hostname(),
          startedAt: getFileLockProcessStartTime(pid),
        },
        port: 18789,
        mode: "foreground",
        supervisor: null,
      }),
      now,
      now,
    );
}

async function expectRestartTargets(pid: number) {
  const { db } = openOpenClawStateDatabase();
  let prepared: unknown;
  service.restart.mockImplementationOnce(async () => {
    prepared = db.prepare("SELECT pid, reason FROM gateway_restart_intent").get();
    return { outcome: "completed" };
  });

  await expect(runServiceRestart(createGatewayServiceRunArgs())).resolves.toBe(true);

  expect(service.restart).toHaveBeenCalledOnce();
  expect(prepared).toEqual({ pid, reason: "gateway.restart" });
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "published 2026.9.4 managed restart admission",
  () => {
    beforeEach(() => {
      resetLifecycleRuntimeLogs();
      lifecycleTestRuntime.error.mockClear();
      resetLifecycleServiceMocks();
      const stateDir = tempDirs.make("openclaw-legacy-restart-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      vi.stubEnv("OPENCLAW_PROFILE", "default");
      vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "");
      vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "");
      openOpenClawStateDatabase();
      service.readCommand.mockResolvedValue({
        programArguments: [process.execPath, path.join(packageRoot, "dist", "index.js"), "gateway"],
        environment: { OPENCLAW_STATE_DIR: stateDir },
      });
      service.readRuntime.mockResolvedValue({ status: "running", pid: process.pid });
    });

    afterEach(async () => {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }
      await Promise.all(children.splice(0).map(({ exited }) => exited));
      closeOpenClawStateDatabaseForTest();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it("prepares restart intent for the verified legacy serving child without a SQLite lease", async () => {
      const lock = await spawnServingChild();
      writeLegacyLock(lock);

      await expectRestartTargets(lock.pid);

      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT count(*) AS count FROM state_leases WHERE scope = 'gateway-owner'")
          .get(),
      ).toEqual({ count: 0 });
    });

    it.each([
      "dead pid",
      "mismatched start time",
      "missing start time",
      "foreign install root",
      "unrelated native main pid",
      "missing native main pid",
      "different state directory",
      "different config path",
      "existing unrelated owner lease",
    ] as const)("refuses legacy restart admission with %s", async (failure) => {
      const lock = await spawnServingChild();
      switch (failure) {
        case "dead pid":
          await stopServingChild(lock.pid);
          break;
        case "mismatched start time":
          lock.startTime = (lock.startTime ?? 0) + 1;
          break;
        case "missing start time":
          delete lock.startTime;
          break;
        case "foreign install root": {
          const root = tempDirs.make("openclaw-foreign-install-");
          fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
          fs.writeFileSync(path.join(root, "openclaw.mjs"), "");
          service.readCommand.mockResolvedValue({
            programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
          });
          break;
        }
        case "unrelated native main pid":
          service.readRuntime.mockResolvedValue({
            status: "running",
            pid: (await spawnServingChild()).pid,
          });
          break;
        case "missing native main pid":
          service.readRuntime.mockResolvedValue({ status: "stopped" });
          break;
        case "different state directory":
          lock.stateDir = tempDirs.make("openclaw-foreign-state-");
          break;
        case "different config path":
          lock.configPath = path.join(lock.stateDir, "another.json");
          break;
        case "existing unrelated owner lease":
          publishUnrelatedOwner();
          break;
      }
      writeLegacyLock(lock);

      await expect(runServiceRestart(createGatewayServiceRunArgs())).rejects.toThrow("__exit__:1");

      expect(service.restart).not.toHaveBeenCalled();
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT count(*) AS count FROM gateway_restart_intent")
          .get(),
      ).toEqual({ count: 0 });
      expect(lifecycleRuntimeLogs.join("\n")).toContain("GATEWAY_RESTART_PREPARATION_REFUSED");
      expect(lifecycleRuntimeLogs.join("\n")).toContain("Gateway was not signaled");
    });

    it("refuses stopped-service startup when a dead SQLite owner coexists with a live legacy lock", async () => {
      const deadOwner = await spawnServingChild();
      await stopServingChild(deadOwner.pid);
      publishUnrelatedOwner(deadOwner.pid);
      writeLegacyLock(await spawnServingChild());
      service.readRuntime.mockResolvedValue({ status: "stopped" });

      await expect(runServiceRestart(createGatewayServiceRunArgs())).rejects.toThrow("__exit__:1");

      expect(service.restart).not.toHaveBeenCalled();
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT count(*) AS count FROM gateway_restart_intent")
          .get(),
      ).toEqual({ count: 0 });
      expect(lifecycleRuntimeLogs.join("\n")).toContain("GATEWAY_RESTART_PREPARATION_REFUSED");
      expect(lifecycleRuntimeLogs.join("\n")).toContain("Gateway was not signaled");
    });

    it.each(["dead pid", "mismatched start time"] as const)(
      "permits stopped-service startup without intent for a legacy lock with %s",
      async (identity) => {
        const lock = await spawnServingChild();
        if (identity === "dead pid") {
          await stopServingChild(lock.pid);
        } else {
          lock.startTime = (lock.startTime ?? 0) + 1;
        }
        writeLegacyLock(lock);
        const { stateLockPath } = resolveGatewayLockPaths(process.env);
        const recordedLock = fs.readFileSync(stateLockPath, "utf8");
        const { db } = openOpenClawStateDatabase();
        let prepared: unknown;
        service.readRuntime.mockResolvedValue({ status: "stopped" });
        service.restart.mockImplementationOnce(async () => {
          prepared = db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get();
          return { outcome: "completed" };
        });

        await expect(runServiceRestart(createGatewayServiceRunArgs())).resolves.toBe(true);

        expect(service.restart).toHaveBeenCalledOnce();
        expect(prepared).toEqual({ count: 0 });
        expect(fs.readFileSync(stateLockPath, "utf8")).toBe(recordedLock);
      },
    );

    it("targets the legacy lock replacement present at intent-write admission", async () => {
      writeLegacyLock(await spawnServingChild());
      const replacement = await spawnServingChild();
      beforeIntentWriteAdmission(() => writeLegacyLock(replacement));

      await expectRestartTargets(replacement.pid);
    });

    it("refuses legacy fallback when an unrelated SQLite owner appears at write admission", async () => {
      writeLegacyLock(await spawnServingChild());
      beforeIntentWriteAdmission(publishUnrelatedOwner);

      await expect(runServiceRestart(createGatewayServiceRunArgs())).rejects.toThrow("__exit__:1");

      expect(service.restart).not.toHaveBeenCalled();
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT count(*) AS count FROM gateway_restart_intent")
          .get(),
      ).toEqual({ count: 0 });
    });
  },
);
