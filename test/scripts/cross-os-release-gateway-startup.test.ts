import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayHandle } from "../../scripts/lib/cross-os-release-checks/config.ts";
import {
  exerciseManagedGatewayLifecycle,
  startGateway,
  waitForGateway,
} from "../../scripts/lib/cross-os-release-checks/runtime.ts";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import { mockProcessPlatform } from "../../src/test-utils/vitest-spies.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeReleaseLane } from "./release-lane.test-support.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const emit = (stream: ChildProcess["stdout"], text: string) =>
  stream?.emit("data", Buffer.from(text));

function makeChild() {
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let exitCode: number | null = null;
  // The external fixture owns settlement; ChildProcess exposes a read-only projection.
  Object.defineProperty(child, "exitCode", { get: () => exitCode });
  const finish = (code: number, stderr = "") => {
    if (exitCode !== null) {
      return;
    }
    exitCode = code;
    emit(child.stderr, stderr);
    child.emit("close", code, null);
  };
  return { child, finish };
}

const exited = "Gateway exited before becoming ready";
it.each([
  ["reported-refusal", "port", null],
  ["current-refusal", "port", null],
  ["stale-refusal", null, exited],
  ["repeated-refusal", "port", exited],
  ["unrelated-failure", null, exited],
  ["config-failure", "config", "Failed to configure replacement Gateway port"],
  ["migration", "migration", null],
] as const)(
  "keeps packaged Gateway startup recovery scoped and bounded: %s",
  async (scenario, recovery, error) => {
    const rootDir = tempDirs.make("cross-os-gateway-startup-");
    const occupied = await reserveTestPortListener({
      offsets: [0],
      createListener: createServer,
    });
    const oldPort = occupied.claim.port;
    const lane = makeReleaseLane(rootDir, { gatewayPort: oldPort });
    const configPath = join(rootDir, "openclaw.json");
    const env = { OPENCLAW_CONFIG_PATH: configPath };
    const readConfig = (): { gateway: { port: number } } =>
      JSON.parse(readFileSync(configPath, "utf8"));
    const writePort = (port: number) =>
      writeFileSync(configPath, JSON.stringify({ gateway: { port } }));
    const gatewayLogPath = join(rootDir, "gateway.log");
    const configWrites: number[] = [];
    const launches: number[] = [];
    const closeChildren: Array<() => void> = [];
    writePort(oldPort);
    const refusal = (port: number) =>
      `Port ${port} is busy but no listener PID could be determined. Run openclaw gateway status --deep to inspect the listener.\n`;
    writeFileSync(gatewayLogPath, scenario === "stale-refusal" ? refusal(oldPort) : "");
    // Mock only the CLI: launch capture, config, ports, log offsets and recovery stay real.
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const cliArgs = Array.isArray(args) ? args.slice(1) : [];
      const { child, finish } = makeChild();
      closeChildren.push(() => finish(0));
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
          writePort(port);
        }
      } else if (cliArgs.includes("--help")) {
        stdout = "--require-rpc";
      } else {
        expect(cliArgs.slice(0, 2)).toEqual(["gateway", "status"]);
        // Status must read the same persisted port as the relaunched Gateway.
        expect(readConfig().gateway.port).toBe(launches.at(-1));
      }
      if (exitCode !== undefined) {
        const code = exitCode;
        queueMicrotask(() => {
          emit(child.stdout, stdout);
          finish(code, stderr);
        });
      }
      return child;
    });
    const holder: { current: GatewayHandle | null } = { current: null };
    try {
      holder.current = await startGateway({ lane, env, logPath: gatewayLogPath });
      const ready = waitForGateway({
        lane,
        env,
        gatewayHolder: holder,
        gatewayLogPath,
        logPath: join(rootDir, "status.log"),
      });
      if (error) {
        await expect(ready).rejects.toThrow(error);
      } else {
        await ready;
      }
      const expectedPort = recovery === "port" ? lane.gatewayPort : oldPort;
      const relaunched = recovery === "port" || recovery === "migration";
      expect(launches).toEqual(relaunched ? [oldPort, expectedPort] : [oldPort]);
      if (recovery === "config") {
        expect(configWrites).toHaveLength(1);
      } else {
        expect(configWrites).toEqual(recovery === "port" ? [expectedPort] : []);
      }
      expect(readConfig()).toEqual({ gateway: { port: expectedPort } });
      if (!recovery) {
        expect(lane.gatewayPort).toBe(oldPort);
      }
      if (recovery === "port") {
        expect(expectedPort).not.toBe(oldPort);
        const replacement = await reserveTestPortListener({
          offsets: [0],
          port: expectedPort,
          createListener: createServer,
        });
        await replacement.releaseListener();
        await replacement.claim.release();
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
  },
);

it.each([0, 1, null])(
  "observes Windows managed start through the lifecycle command allowance (exit %s)",
  async (startExit) => {
    const rootDir = tempDirs.make("cross-os-managed-start-");
    const lane = makeReleaseLane(rootDir, { name: "installer-fresh", gatewayPort: 18789 });
    const platform = mockProcessPlatform("win32");
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const { promise: started, resolve: notifyStart } = Promise.withResolvers<void>();
    let finishStart: (() => void) | undefined;
    const events = { startedAt: 0, killedAt: 0, statusChecks: 0 };
    // Mock only CLI/taskkill; lifecycle, deadlines, logs and RPC status stay real.
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const argv = Array.isArray(args) ? args : [];
      const { child, finish } = makeChild();
      Object.defineProperty(child, "pid", { value: 4242 });
      if (argv[1] === "start") {
        events.startedAt = Date.now();
        finishStart = () => finish(1);
        if (startExit !== null) {
          setTimeout(
            () => finish(startExit, startExit === 1 ? "fixture startup refused" : ""),
            180_000,
          );
        }
        queueMicrotask(() => {
          emit(child.stdout, "Started Scheduled Task: OpenClaw Gateway\n");
          notifyStart();
        });
      } else {
        queueMicrotask(() => {
          if (argv.includes("--help")) {
            emit(child.stdout, "--require-rpc --force");
          } else if (argv[1] === "status") {
            expect(argv).toContain("--require-rpc");
            events.statusChecks += 1;
          }
          finish(0);
        });
      }
      return child;
    });
    vi.mocked(spawnSync).mockImplementation(() => {
      events.killedAt = Date.now();
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
      }).catch((error: unknown) => error);
      await Promise.race([
        started,
        result.then(() => expect.unreachable("Lifecycle settled before the start fixture")),
      ]);
      await vi.advanceTimersByTimeAsync(startExit === null ? 360_000 : 180_000);
      const outcome = await result;
      expect(events.statusChecks).toBe(startExit === 0 ? 3 : 2);
      if (startExit === 0) {
        expect(outcome).toBeUndefined();
      } else {
        expect(outcome).toBeInstanceOf(Error);
        expect(String(outcome)).toContain(
          startExit === null ? "Command timed out:" : "fixture startup refused",
        );
      }
      if (startExit === null) {
        expect(events.killedAt - events.startedAt).toBe(360_000);
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
    } finally {
      vi.mocked(spawn).mockReset();
      vi.mocked(spawnSync).mockReset();
      vi.useRealTimers();
      platform.mockRestore();
    }
  },
);
