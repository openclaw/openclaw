import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayHandle, LaneState } from "../../scripts/lib/cross-os-release-checks/config.ts";
import {
  exerciseManagedGatewayLifecycle,
  startGateway,
  waitForGateway,
} from "../../scripts/lib/cross-os-release-checks/runtime.ts";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import { mockProcessPlatform } from "../../src/test-utils/vitest-spies.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  "reported-refusal",
  "current-refusal",
  "stale-refusal",
  "repeated-refusal",
  "unrelated-failure",
  "config-failure",
  "migration",
] as const)("keeps packaged Gateway startup recovery scoped and bounded: %s", async (scenario) => {
  const rootDir = tempDirs.make("cross-os-gateway-startup-");
  const occupied = await reserveTestPortListener({
    offsets: [0],
    createListener: createServer,
  });
  const oldPort = occupied.claim.port;
  const lane: LaneState = {
    name: "fresh",
    rootDir,
    prefixDir: rootDir,
    homeDir: rootDir,
    stateDir: rootDir,
    appDataDir: rootDir,
    gatewayPort: oldPort,
    phaseTimings: [],
  };
  const configPath = join(rootDir, "openclaw.json");
  const gatewayLogPath = join(rootDir, "gateway.log");
  const configWrites: number[] = [];
  const launches: number[] = [];
  const closeChildren: Array<() => void> = [];
  writeFileSync(configPath, JSON.stringify({ gateway: { port: oldPort } }));
  const refusal = (port: number) =>
    `Port ${port} is busy but no listener PID could be determined. Run openclaw gateway status --deep to inspect the listener.\n`;
  writeFileSync(gatewayLogPath, scenario === "stale-refusal" ? refusal(oldPort) : "");
  // The CLI is the external boundary. Keep real launch capture, config commands,
  // port reservation, log offsets, and packaged readiness/recovery in the harness.
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const cliArgs = Array.isArray(args) ? args.slice(1) : [];
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let observedExit: number | null = null;
    // ChildProcess exposes a read-only exit projection; the external fixture owns settlement.
    Object.defineProperty(child, "exitCode", { get: () => observedExit });
    const finish = (code: number) => {
      observedExit = code;
      child.emit("close", code, null);
    };
    closeChildren.push(() => {
      if (observedExit === null) {
        finish(0);
      }
    });
    let exitCode: number | undefined = 0;
    let stdout = "";
    let stderr = "";
    if (cliArgs[0] === "gateway" && cliArgs[1] === "run") {
      const port = Number(cliArgs[cliArgs.indexOf("--port") + 1]);
      launches.push(port);
      if (launches.length === 1 || scenario === "repeated-refusal") {
        exitCode = 1;
        stderr =
          scenario === "migration"
            ? "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready.\n"
            : scenario === "current-refusal"
              ? `port ${port} is still busy after --force, but no listener PID could be determined\n`
              : scenario === "stale-refusal" || scenario === "unrelated-failure"
                ? "Gateway configuration is invalid.\n"
                : refusal(port);
      } else {
        exitCode = undefined;
      }
    } else if (cliArgs[0] === "config" && cliArgs[1] === "set") {
      expect(cliArgs[2]).toBe("gateway.port");
      const port = Number(cliArgs[3]);
      configWrites.push(port);
      exitCode = scenario === "config-failure" ? 1 : 0;
      if (exitCode === 0) {
        writeFileSync(configPath, JSON.stringify({ gateway: { port } }));
      }
    } else if (cliArgs.includes("--help")) {
      stdout = "--require-rpc";
    } else {
      expect(cliArgs.slice(0, 2)).toEqual(["gateway", "status"]);
      const configured = JSON.parse(readFileSync(configPath, "utf8")) as {
        gateway: { port: number };
      };
      // A relaunch is not ready until the same port is persisted for status,
      // dashboard, and agent commands that consume the lane's configuration.
      expect(configured.gateway.port).toBe(launches.at(-1));
    }
    if (exitCode !== undefined) {
      const code = exitCode;
      queueMicrotask(() => {
        child.stdout?.emit("data", Buffer.from(stdout));
        child.stderr?.emit("data", Buffer.from(stderr));
        finish(code);
      });
    }
    return child;
  });
  const holder: { current: GatewayHandle | null } = { current: null };
  try {
    holder.current = await startGateway({
      lane,
      env: { OPENCLAW_CONFIG_PATH: configPath },
      logPath: gatewayLogPath,
    });
    const ready = waitForGateway({
      lane,
      env: { OPENCLAW_CONFIG_PATH: configPath },
      gatewayHolder: holder,
      gatewayLogPath,
      logPath: join(rootDir, "status.log"),
    });
    if (scenario === "stale-refusal" || scenario === "unrelated-failure") {
      await expect(ready).rejects.toThrow("Gateway exited before becoming ready");
      expect(launches).toEqual([oldPort]);
      expect(configWrites).toEqual([]);
      expect(lane.gatewayPort).toBe(oldPort);
    } else if (scenario === "config-failure") {
      await expect(ready).rejects.toThrow("Failed to configure replacement Gateway port");
      expect(launches).toEqual([oldPort]);
      expect(configWrites).toHaveLength(1);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ gateway: { port: oldPort } });
    } else {
      if (scenario === "repeated-refusal") {
        await expect(ready).rejects.toThrow("Gateway exited before becoming ready");
      } else {
        await ready;
      }
      const expectedPort = scenario === "migration" ? oldPort : lane.gatewayPort;
      expect(launches).toEqual([oldPort, expectedPort]);
      expect(configWrites).toEqual(scenario === "migration" ? [] : [expectedPort]);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        gateway: { port: expectedPort },
      });
      if (scenario !== "migration") {
        expect(expectedPort).not.toBe(oldPort);
        const replacement = await reserveTestPortListener({
          offsets: [0],
          port: expectedPort,
          createListener: createServer,
        });
        await replacement.releaseListener();
        await replacement.claim.release();
      }
    }
    expect(occupied.listener.listening).toBe(true);
  } finally {
    const gateway = holder.current;
    for (const close of closeChildren) {
      close();
    }
    await gateway?.closeLog();
    await occupied.releaseListener();
    await occupied.claim.release();
    vi.mocked(spawn).mockReset();
  }
});

it.each([0, 1, null])(
  "observes Windows managed start through the lifecycle command allowance (exit %s)",
  async (startExit) => {
    const rootDir = tempDirs.make("cross-os-managed-start-");
    const lane: LaneState = {
      name: "installer-fresh",
      rootDir,
      prefixDir: rootDir,
      homeDir: rootDir,
      stateDir: rootDir,
      appDataDir: rootDir,
      gatewayPort: 18789,
      phaseTimings: [],
    };
    const platform = mockProcessPlatform("win32");
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    let notifyStart!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStart = resolve;
    });
    let finishStart: (() => void) | undefined;
    let startedAt = 0;
    let killedAt = 0;
    let statusChecks = 0;
    // Model only the external CLI/taskkill boundary. The lifecycle driver,
    // invocation adapter, process deadline, logs, and RPC status gates stay real.
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const argv = Array.isArray(args) ? args : [];
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: 4242 });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let exited = false;
      const finish = (code: number, stderr = "") => {
        if (exited) {
          return;
        }
        exited = true;
        child.stderr?.emit("data", Buffer.from(stderr));
        child.emit("close", code, null);
      };
      if (argv[1] === "start") {
        startedAt = Date.now();
        finishStart = () => finish(1);
        if (startExit !== null) {
          setTimeout(
            () => finish(startExit, startExit === 1 ? "fixture startup refused" : ""),
            180_000,
          );
        }
        queueMicrotask(() => {
          child.stdout?.emit("data", Buffer.from("Started Scheduled Task: OpenClaw Gateway\n"));
          notifyStart();
        });
      } else {
        queueMicrotask(() => {
          if (argv.includes("--help")) {
            child.stdout?.emit("data", Buffer.from("--require-rpc --force"));
          } else if (argv[1] === "status") {
            expect(argv).toContain("--require-rpc");
            statusChecks += 1;
          }
          finish(0);
        });
      }
      return child;
    });
    vi.mocked(spawnSync).mockImplementation(() => {
      killedAt = Date.now();
      queueMicrotask(() => finishStart?.());
      return { pid: 4243, output: [], stdout: "", stderr: "", status: 0, signal: null };
    });
    const logPrefix = join(rootDir, "gateway");
    try {
      const result = exerciseManagedGatewayLifecycle({
        lane,
        cliPath: "C:\\fixture\\openclaw.exe",
        env: {},
        logPrefix,
      }).then(
        () => "ready",
        (error: unknown) => error,
      );
      await Promise.race([
        started,
        result.then(() => {
          throw new Error("Lifecycle settled before the start fixture");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(startExit === null ? 360_000 : 180_000);
      const outcome = await result;
      if (startExit === 0) {
        expect(outcome).toBe("ready");
        expect(statusChecks).toBe(3);
        expect(spawnSync).not.toHaveBeenCalled();
      } else {
        expect(outcome).toBeInstanceOf(Error);
        expect(String(outcome)).toContain(
          startExit === null ? "Command timed out:" : "fixture startup refused",
        );
        expect(statusChecks).toBe(2);
        if (startExit === null) {
          expect(killedAt - startedAt).toBe(360_000);
          expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
            expect.stringMatching(/taskkill\.exe$/u),
            ["/PID", "4242", "/T", "/F"],
            expect.objectContaining({ timeout: 10_000 }),
          );
          expect(readFileSync(logPrefix + "-start.log", "utf8")).toContain(
            "process-tree=terminated pid=4242",
          );
        } else {
          expect(spawnSync).not.toHaveBeenCalled();
        }
      }
    } finally {
      vi.mocked(spawn).mockReset();
      vi.mocked(spawnSync).mockReset();
      vi.useRealTimers();
      platform.mockRestore();
    }
  },
);
