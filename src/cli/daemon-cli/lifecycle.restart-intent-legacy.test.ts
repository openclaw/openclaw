import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import {
  readGatewayLockProcessNamespace,
  type LockPayload,
} from "../../infra/gateway-lock-payload.js";
import { resolveGatewayLockPaths } from "../../infra/gateway-lock.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { beforeIntentWriteAdmission } from "./lifecycle.restart-intent.test-support.js";
import {
  createGatewayServiceRunArgs,
  lifecycleTestRuntime,
  lifecycleRuntimeLogs,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
} from "./test-helpers/lifecycle-core-harness.js";

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: lifecycleTestRuntime,
}));
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

type LegacyLock = LockPayload & { stateDir: string; ownerId: string; port: number };
const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = [];
const query = (sql: string) => openOpenClawStateDatabase().db.prepare(sql);
const running = (pid = process.pid) => ({ status: "running" as const, pid });

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
  const { configPath, stateDir } = resolveGatewayLockPaths(process.env);
  return {
    pid: child.pid,
    startTime,
    ownerId: `legacy-gateway-${child.pid}`,
    createdAt: new Date().toISOString(),
    configPath,
    stateDir,
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

function publishOwner(pid = process.pid, supervised = false) {
  const now = Date.now();
  query(
    `INSERT OR REPLACE INTO state_leases
     (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
     VALUES ('gateway-owner', 'global', 'unrelated-owner', ?, ?, ?, ?, ?)`,
  ).run(
    now + 60_000,
    now,
    JSON.stringify({
      owner: {
        pid,
        host: hostname(),
        startedAt: getFileLockProcessStartTime(pid),
        processNamespace: readGatewayLockProcessNamespace(),
      },
      port: 18789,
      mode: supervised ? "supervised" : "foreground",
      supervisor: supervised
        ? process.platform === "darwin"
          ? { kind: "launchd", name: resolveLaunchAgentLabel(process.env) }
          : { kind: "systemd", name: resolveSystemdServiceName(process.env) }
        : null,
    }),
    now,
    now,
  );
}

function readIntent() {
  return query("SELECT pid, reason FROM gateway_restart_intent").get();
}

async function expectRestartRefused(message?: string) {
  await expect(runServiceRestart(createGatewayServiceRunArgs())).rejects.toThrow("__exit__:1");
  expect(service.restart).not.toHaveBeenCalled();
  expect(readIntent()).toBeUndefined();
  if (message) {
    expect(lifecycleRuntimeLogs.join("\n")).toContain(message);
  }
}

async function expectRestartTargets(pid?: number) {
  let prepared: unknown;
  service.restart.mockImplementationOnce(async () => {
    prepared = readIntent();
    return { outcome: "completed" };
  });
  await expect(runServiceRestart(createGatewayServiceRunArgs())).resolves.toBe(true);
  expect(service.restart).toHaveBeenCalledOnce();
  expect(prepared).toEqual(pid === undefined ? undefined : { pid, reason: "gateway.restart" });
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
      service.readRuntime.mockResolvedValue(running());
    });

    afterEach(async () => {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      }
      await Promise.all(children.splice(0).map(({ exited }) => exited));
      closeOpenClawStateDatabaseForTest();
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const refusals: Record<string, (lock: LegacyLock) => void | Promise<void>> = {
      "dead pid": async (lock) => {
        await stopServingChild(lock.pid);
        service.readRuntime.mockResolvedValue(running(lock.pid));
      },
      "mismatched start time": (lock) => {
        lock.startTime = (lock.startTime ?? 0) + 1;
      },
      "missing start time": (lock) => {
        delete lock.startTime;
      },
      "foreign install root": () => {
        const root = tempDirs.make("openclaw-foreign-install-");
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
        fs.writeFileSync(path.join(root, "openclaw.mjs"), "");
        service.readCommand.mockResolvedValue({
          programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
        });
      },
      "unrelated native main pid": async () => {
        service.readRuntime.mockResolvedValue(running((await spawnServingChild()).pid));
      },
      "different state directory": (lock) => {
        lock.stateDir = tempDirs.make("openclaw-foreign-state-");
      },
      "different config path": (lock) => {
        lock.configPath = path.join(lock.stateDir, "another.json");
      },
      "stopped service with dead SQLite owner and live legacy lock": async () => {
        const deadOwner = await spawnServingChild();
        await stopServingChild(deadOwner.pid);
        publishOwner(deadOwner.pid);
        service.readRuntime.mockResolvedValue({ status: "stopped" });
      },
    };
    it.each(Object.entries(refusals))(
      "refuses legacy restart admission with %s",
      async (_name, arrange) => {
        const lock = await spawnServingChild();
        await arrange(lock);
        writeLegacyLock(lock);
        await expectRestartRefused("GATEWAY_RESTART_PREPARATION_REFUSED");
        expect(lifecycleRuntimeLogs.join("\n")).toContain("Gateway was not signaled");
      },
    );

    it.each([
      ["absent", "gateway"],
      ["absent", "foreign process"],
      ["absent", "timeout"],
      ["dead", "gateway"],
      ["dead", "foreign process"],
      ["dead", "timeout"],
    ] as const)(
      "waits for a native startup owner before restart admission: %s → %s",
      async (previous, publication) => {
        const native = await spawnServingChild();
        const published = publication === "foreign process" ? await spawnServingChild() : native;
        if (previous === "dead") {
          const retired = await spawnServingChild();
          publishOwner(retired.pid);
          writeLegacyLock(retired);
          await stopServingChild(retired.pid);
        }
        const waiting = Promise.withResolvers<void>();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        service.readRuntime
          .mockResolvedValueOnce(running(native.pid))
          .mockImplementation(async () => {
            if (publication !== "timeout") {
              setTimeout(() => {
                writeLegacyLock(published);
                publishOwner(published.pid, publication === "gateway");
              }, 100);
            }
            waiting.resolve();
            return running(native.pid);
          });
        let recorded: unknown;
        service.restart.mockImplementationOnce(async () => {
          recorded = readIntent();
          return { outcome: "completed" };
        });
        const result = runServiceRestart(createGatewayServiceRunArgs()).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await expect(
          Promise.race([waiting.promise.then(() => "waiting"), result.then(() => "settled")]),
        ).resolves.toBe("waiting");
        expect(service.restart).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(publication === "timeout" ? 45_000 : 200);
        if (publication === "gateway") {
          await expect(result).resolves.toEqual({ value: true });
          expect(recorded).toEqual({ pid: native.pid, reason: "gateway.restart" });
        } else {
          await expect(result).resolves.toHaveProperty("error");
          expect(service.restart).not.toHaveBeenCalled();
          expect(readIntent()).toBeUndefined();
        }
      },
    );

    it.each(["dead pid", "mismatched start time"] as const)(
      "permits stopped-service startup without intent for a legacy lock with %s",
      async (identity) => {
        const lock = await spawnServingChild();
        await refusals[identity]!(lock);
        writeLegacyLock(lock);
        const { stateLockPath } = resolveGatewayLockPaths(process.env);
        const recordedLock = fs.readFileSync(stateLockPath, "utf8");
        service.readRuntime.mockResolvedValue({ status: "stopped" });
        await expectRestartTargets();
        expect(fs.readFileSync(stateLockPath, "utf8")).toBe(recordedLock);
      },
    );

    it.each(["legacy replacement", "unrelated SQLite owner"])(
      "revalidates %s at intent-write admission",
      async (owner) => {
        writeLegacyLock(await spawnServingChild());
        if (owner === "unrelated SQLite owner") {
          beforeIntentWriteAdmission(publishOwner);
          await expectRestartRefused();
          return;
        }
        const replacement = await spawnServingChild();
        beforeIntentWriteAdmission(() => writeLegacyLock(replacement));
        await expectRestartTargets(replacement.pid);
        expect(
          query("SELECT count(*) AS count FROM state_leases WHERE scope = 'gateway-owner'").get(),
        ).toEqual({ count: 0 });
      },
    );
  },
);
