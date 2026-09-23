// Launchd integration tests cover daemon CLI behavior in macOS-like scenarios.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { waitForGatewayHealthyRestart } from "../cli/daemon-cli/restart-health.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { LOOPBACK_PORT_PROBE_HOSTS, probePortUsage } from "../infra/ports-probe.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import { withTimeout } from "../utils/with-timeout.js";
import { probeLaunchAgentState } from "./launchd-runtime.js";
import {
  assertNoLaunchdFixtureStateLeases,
  buildLaunchdSettlementProbe,
} from "./launchd-settlement.test-helpers.js";
import {
  installLaunchAgent,
  readLaunchAgentRuntime,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { resolveGatewayService, startGatewayService, type GatewayService } from "./service.js";

const WAIT_INTERVAL_MS = 200;
const WAIT_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 45_000;

function canRunLaunchdIntegration(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  if (typeof process.getuid !== "function") {
    return false;
  }
  const domain = `gui/${process.getuid()}`;
  const probe = spawnSync("launchctl", ["print", domain], { encoding: "utf8" });
  if (probe.error) {
    return false;
  }
  return probe.status === 0;
}

const describeLaunchdIntegration = canRunLaunchdIntegration() ? describe : describe.skip;

function resolveGuiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function waitForRunningRuntime(params: {
  env: GatewayServiceEnv;
  pidNot?: number;
  timeoutMs?: number;
}): Promise<{ pid: number }> {
  const timeoutMs = params.timeoutMs ?? WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const runtime = await readLaunchAgentRuntime(params.env);
    lastStatus = runtime.status ?? "unknown";
    lastPid = runtime.pid;
    if (
      runtime.status === "running" &&
      typeof runtime.pid === "number" &&
      runtime.pid > 1 &&
      (params.pidNot === undefined || runtime.pid !== params.pidNot)
    ) {
      return { pid: runtime.pid };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }
  throw new Error(
    `Timed out waiting for launchd runtime (status=${lastStatus}, pid=${lastPid ?? "none"})`,
  );
}

async function waitForNotRunningRuntime(params: {
  env: GatewayServiceEnv;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const runtime = await readLaunchAgentRuntime(params.env);
    lastStatus = runtime.status ?? "unknown";
    lastPid = runtime.pid;
    if (runtime.status !== "running" && runtime.pid === undefined) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }
  throw new Error(
    `Timed out waiting for launchd runtime to stop (status=${lastStatus}, pid=${lastPid ?? "none"})`,
  );
}

function launchEnvOrThrow(env: GatewayServiceEnv | undefined): GatewayServiceEnv {
  if (!env) {
    throw new Error("launchd integration env was not initialized");
  }
  return env;
}

async function initializeLaunchdRuntime(launchEnv: GatewayServiceEnv, stdout: PassThrough) {
  await withTimeout(
    (async () => {
      await installLaunchAgent({
        env: launchEnv,
        stdout,
        programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      });
      await waitForRunningRuntime({ env: launchEnv });
    })(),
    STARTUP_TIMEOUT_MS,
    { message: "Timed out initializing launchd integration runtime" },
  );
}

async function writeLaunchAgentProbeScript(params: {
  eventsPath: string;
  scriptPath: string;
}): Promise<void> {
  await fs.writeFile(
    params.scriptPath,
    [
      'const fs = require("node:fs");',
      `const eventsPath = ${JSON.stringify(params.eventsPath)};`,
      "fs.appendFileSync(eventsPath, `start ${process.pid}\\n`);",
      'for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {',
      "  process.on(signal, () => {",
      "    fs.appendFileSync(eventsPath, `${signal} ${process.pid}\\n`);",
      "    process.exit(0);",
      "  });",
      "}",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function expectRuntimePidReplaced(params: {
  env: GatewayServiceEnv;
  previousPid: number;
}): Promise<void> {
  const after = await waitForRunningRuntime({
    env: params.env,
    pidNot: params.previousPid,
  });
  expect(after.pid).toBeGreaterThan(1);
  expect(after.pid).not.toBe(params.previousPid);
  await fs.access(resolveLaunchAgentPlistPath(params.env));
}

describeLaunchdIntegration("launchd integration", () => {
  let env: GatewayServiceEnv | undefined;
  let homeDir = "";
  const stdout = new PassThrough();

  it("real launchctl: node-host LaunchAgent stop/restart survives a co-located busy Gateway port (#124296)", async () => {
    // Real-world proof for https://github.com/openclaw/openclaw/issues/124296:
    // this drives actual `launchctl` LaunchAgents (no mocked port-inspection
    // or launchctl calls) to reproduce the reported false-positive
    // "gateway port is still busy" failure and confirm the fix resolves it.
    const testId = randomUUID().slice(0, 8);
    const gatewayPort = 19_500 + (Number.parseInt(testId.slice(0, 4), 16) % 400);

    // Real "gateway" LaunchAgent that genuinely binds the scratch port, so
    // the port really is busy for the whole test — no port mocking at all.
    const gatewayHomeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `openclaw-launchd-int-gw-${testId}-`),
    );
    const gatewayEnv: GatewayServiceEnv = {
      HOME: gatewayHomeDir,
      OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.launchd-int-gw-${testId}`,
      OPENCLAW_LOG_PREFIX: `gateway-launchd-int-gw-${testId}`,
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    };

    // Real "node-host" LaunchAgent, co-located on the same machine, tagged
    // with the node service kind. It never binds the gateway port itself.
    const nodeHomeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `openclaw-launchd-int-node-${testId}-`),
    );
    const nodeEnv: GatewayServiceEnv = {
      HOME: nodeHomeDir,
      OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.launchd-int-node-${testId}`,
      OPENCLAW_LOG_PREFIX: `gateway-launchd-int-node-${testId}`,
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    };

    try {
      await installLaunchAgent({
        env: gatewayEnv,
        stdout,
        programArguments: [
          process.execPath,
          "-e",
          `require("node:http").createServer((_req,res)=>res.end("ok")).listen(${gatewayPort}, "127.0.0.1", () => {}); setInterval(() => {}, 1000);`,
        ],
      });
      await waitForRunningRuntime({ env: gatewayEnv });

      // Prove the gateway port is genuinely bound right now via a real TCP
      // probe (no launchd-status inference) before exercising the node-host
      // lifecycle against it. This closes the gap where a LaunchAgent could
      // report "running" before its listener has actually bound the port.
      await expect
        .poll(() => probePortUsage(gatewayPort, LOOPBACK_PORT_PROBE_HOSTS), {
          timeout: 10_000,
          interval: 100,
        })
        .toBe("busy");

      await installLaunchAgent({
        env: nodeEnv,
        stdout,
        programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      });
      const nodeBefore = await waitForRunningRuntime({ env: nodeEnv });

      // Re-confirm the port is still genuinely busy immediately before the
      // stop call, so the assertion below is tied to a real, current probe.
      await expect(probePortUsage(gatewayPort, LOOPBACK_PORT_PROBE_HOSTS)).resolves.toBe("busy");

      // The gateway port is genuinely still bound by the co-located gateway
      // LaunchAgent right now. Stopping the node-host LaunchAgent must not
      // fail with the false-positive "gateway port is still busy" error.
      await expect(stopLaunchAgent({ env: nodeEnv, stdout })).resolves.not.toThrow();
      await waitForNotRunningRuntime({ env: nodeEnv });

      // Confirm the co-located gateway is genuinely untouched throughout.
      const gatewayStillRunning = await readLaunchAgentRuntime(gatewayEnv);
      expect(gatewayStillRunning.status).toBe("running");

      // Re-install (stop leaves it uninstalled-from-runtime-state in some
      // paths depending on service semantics) and exercise restart too.
      await installLaunchAgent({
        env: nodeEnv,
        stdout,
        programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      });
      await waitForRunningRuntime({ env: nodeEnv, pidNot: nodeBefore.pid });
      const nodeRunningBeforeRestart = await readLaunchAgentRuntime(nodeEnv);

      // Re-probe immediately before restart too: the port must still be
      // genuinely busy (real TCP probe, not inferred from launchd status)
      // for this to be a valid proof of the restart-guard fix.
      await expect(probePortUsage(gatewayPort, LOOPBACK_PORT_PROBE_HOSTS)).resolves.toBe("busy");

      await expect(restartLaunchAgent({ env: nodeEnv, stdout })).resolves.not.toThrow();
      await expectRuntimePidReplaced({
        env: nodeEnv,
        previousPid: nodeRunningBeforeRestart.pid ?? nodeBefore.pid,
      });

      const gatewayStillRunningAfterRestart = await readLaunchAgentRuntime(gatewayEnv);
      expect(gatewayStillRunningAfterRestart.status).toBe("running");
    } finally {
      await uninstallLaunchAgent({ env: nodeEnv, stdout }).catch(() => {});
      await uninstallLaunchAgent({ env: gatewayEnv, stdout }).catch(() => {});
      await fs.rm(nodeHomeDir, { recursive: true, force: true });
      await fs.rm(gatewayHomeDir, { recursive: true, force: true });
    }
  }, 90_000);

  beforeAll(async () => {
    const testId = randomUUID().slice(0, 8);
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-launchd-int-${testId}-`));
    env = {
      HOME: homeDir,
      OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.launchd-int-${testId}`,
      OPENCLAW_LOG_PREFIX: `gateway-launchd-int-${testId}`,
    };
  });

  afterAll(async () => {
    if (env) {
      try {
        await uninstallLaunchAgent({ env, stdout });
      } catch {
        // Best-effort cleanup in case launchctl state already changed.
      }
    }
    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("waits for a loaded LaunchAgent to settle after two pre-listener exits", async ({
    signal,
    onTestFinished,
  }) => {
    const completion = (async () => {
      signal.throwIfAborted();
      const resourceOwner = findVitestResourceOwner();
      if (!resourceOwner) {
        throw new Error("Native launchd fixture requires canonical Vitest resource custody");
      }
      // A timeout does not join the callback or launchd job. Retain the containing
      // namespace until this exact target and every recorded child are verified gone.
      const releaseResources = resourceOwner.claim();
      const label = `ai.openclaw.launchd-settle-${randomUUID()}`;
      const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launchd-settle-"));
      const port = await getFreePort();
      const stateDir = path.join(fixtureHome, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const scriptPath = path.join(fixtureHome, "probe.cjs");
      const eventsPath = path.join(fixtureHome, "events.jsonl");
      const releasePath = path.join(fixtureHome, "release-first-exit");
      const configContents = JSON.stringify({ gateway: { port, bind: "loopback" } });
      const custodyPath = path.join(fixtureHome, "custody.json");
      const target = `${resolveGuiDomain()}/${label}`;
      const launchEnv: GatewayServiceEnv = {
        HOME: fixtureHome,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_INCLUDE_ROOTS: undefined,
        OPENCLAW_OAUTH_DIR: undefined,
        OPENCLAW_LAUNCHD_LABEL: label,
        OPENCLAW_LOG_PREFIX: "launchd-settle",
        OPENCLAW_GATEWAY_PORT: String(port),
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_WINDOWS_TASK_NAME: undefined,
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      };
      const plistPath = resolveLaunchAgentPlistPath(launchEnv);
      const failures: unknown[] = [];
      let ownsTarget = false;
      const readEvents = async () =>
        (await fs.readFile(eventsPath, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const event: unknown = JSON.parse(line);
            if (
              !isRecord(event) ||
              (event.event !== "start" && event.event !== "listen" && event.event !== "exit") ||
              typeof event.ordinal !== "number" ||
              !Number.isInteger(event.ordinal) ||
              event.ordinal < 1 ||
              typeof event.pid !== "number" ||
              !Number.isInteger(event.pid) ||
              event.pid <= 1
            ) {
              throw new Error("Invalid launchd fixture process receipt");
            }
            return { event: event.event, ordinal: event.ordinal, pid: event.pid };
          });
      const assertNoOwnerLease = async () => {
        expect(readGatewayOwnerLease({ env: launchEnv })).toBeUndefined();
        // Probe-host config reads record config-health metadata. A SQLite file is
        // not an owner lease; reject every lease row, including other ports/scopes.
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => assertNoLaunchdFixtureStateLeases(db),
          { env: launchEnv },
        );
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(configContents);
      };

      await withEnvAsync(launchEnv, async () => {
        try {
          await fs.mkdir(stateDir);
          await fs.writeFile(configPath, configContents, {
            flag: "wx",
            mode: 0o600,
          });
          await fs.writeFile(eventsPath, "", { flag: "wx", mode: 0o600 });
          await fs.writeFile(
            scriptPath,
            buildLaunchdSettlementProbe({ eventsPath, releasePath, port }),
            { flag: "wx", mode: 0o600 },
          );
          signal.throwIfAborted();
          expect(await probeLaunchAgentState(target, 5_000)).toEqual({ state: "not-loaded" });
          await expect(fs.lstat(plistPath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(probePortUsage(port, LOOPBACK_PORT_PROBE_HOSTS)).resolves.toBe("free");
          await assertNoOwnerLease();
          await expect(fs.stat(resolveOpenClawStateSqlitePath(launchEnv))).rejects.toMatchObject({
            code: "ENOENT",
          });
          // Publish custody only after admission, before launchd can outlive Vitest.
          await fs.writeFile(
            custodyPath,
            JSON.stringify({
              target,
              port,
              env: launchEnv,
              plistPath,
              scriptPath,
              eventsPath,
              releasePath,
              fixtureHome,
              executorPid: process.pid,
              resourceRoot: resourceOwner.root,
            }),
            { flag: "wx", mode: 0o600 },
          );
          console.info(`launchd fixture custody: ${custodyPath}`);
          signal.throwIfAborted();
          ownsTarget = true;
          await installLaunchAgent({
            env: launchEnv,
            stdout,
            programArguments: [process.execPath, scriptPath],
            workingDirectory: fixtureHome,
            environment: { ...launchEnv, NODE_OPTIONS: "" },
          });
          signal.throwIfAborted();
          const service = resolveGatewayService();
          const loaded: Array<{ args: Parameters<GatewayService["isLoaded"]>[0]; value: boolean }> =
            [];
          const runtimes: Array<Awaited<ReturnType<GatewayService["readRuntime"]>>> = [];
          let stoppedFreeAfterGrace = 0;
          let crossedStoppedFreeExit = false;
          const observedService: GatewayService = {
            ...service,
            async isLoaded(args) {
              const value = await service.isLoaded(args);
              loaded.push({ args, value });
              return value;
            },
            async readRuntime(...args) {
              const runtime = await service.readRuntime(...args);
              if (runtimes.length === 20) {
                // Align the second immediate exit's native throttle window with
                // the old grace boundary. Do not change the returned observation.
                await fs.writeFile(releasePath, "", { flag: "wx", mode: 0o600 });
              }
              // With default 500 ms polling the old predicate admitted attempt 20,
              // then exited on six stopped/free samples. Do not infer this from PIDs.
              const stoppedFree =
                runtime.status === "stopped" &&
                (await probePortUsage(port, LOOPBACK_PORT_PROBE_HOSTS)) === "free";
              stoppedFreeAfterGrace =
                runtimes.length >= 20 && stoppedFree ? stoppedFreeAfterGrace + 1 : 0;
              crossedStoppedFreeExit ||= stoppedFreeAfterGrace >= 6;
              runtimes.push(runtime);
              return runtime;
            },
          };
          // Exercise default PID/port health, not RPC/build/plugin health. This plain Node
          // listener publishes no SQLite owner lease; a runtime PID is not that owner.
          const result = await waitForGatewayHealthyRestart({
            service: observedService,
            env: launchEnv,
            port,
            requireRunningService: true,
            settle: { probes: 12 },
            signal,
          });
          expect(
            crossedStoppedFreeExit,
            "Native scheduling did not exercise the stopped/free early-exit predicate",
          ).toBe(true);
          expect(loaded).toHaveLength(1);
          expect(loaded[0]?.value).toBe(true);
          expect(loaded[0]?.args.env).toBe(launchEnv);
          expect(loaded[0]?.args.timeoutMs).toBeGreaterThan(0);
          expect(loaded[0]?.args.timeoutMs).toBeLessThanOrEqual(5_000);
          const events = await readEvents();
          const starts = events.filter((event) => event.event === "start");
          expect(starts.map((event) => event.ordinal)).toEqual([1, 2, 3]);
          expect(events.filter((event) => event.event === "exit")).toEqual(
            starts.slice(0, 2).map(({ ordinal, pid }) => ({ event: "exit", ordinal, pid })),
          );
          const finalPid = starts[2]?.pid;
          expect(events.filter((event) => event.event === "listen")).toEqual([
            { event: "listen", ordinal: 3, pid: finalPid },
          ]);
          expect(result).toMatchObject({
            healthy: true,
            waitOutcome: "healthy",
            runtime: { status: "running", pid: finalPid },
          });
          expect(result.portUsage.listeners.some((listener) => listener.pid === finalPid)).toBe(
            true,
          );
          expect(runtimes.slice(-12).map(({ status, pid }) => ({ status, pid }))).toEqual(
            Array.from({ length: 12 }, () => ({ status: "running", pid: finalPid })),
          );
          await assertNoOwnerLease();
        } catch (error) {
          failures.push(error);
        } finally {
          if (ownsTarget) {
            try {
              await uninstallLaunchAgent({ env: launchEnv, stdout });
            } catch (error) {
              failures.push(error);
            }
            try {
              await expect
                .poll(async () => (await probeLaunchAgentState(target, 5_000)).state, {
                  timeout: 10_000,
                  interval: WAIT_INTERVAL_MS,
                })
                .toBe("not-loaded");
              const pids = (await readEvents()).map((event) => event.pid);
              await expect
                .poll(() => pids.every(isPidDefinitelyDead), {
                  timeout: 10_000,
                  interval: WAIT_INTERVAL_MS,
                })
                .toBe(true);
              await expect(probePortUsage(port, LOOPBACK_PORT_PROBE_HOSTS)).resolves.toBe("free");
              await expect(fs.lstat(plistPath)).rejects.toMatchObject({ code: "ENOENT" });
              await assertNoOwnerLease();
            } catch (error) {
              failures.push(error);
            }
          }
        }
      });
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `LaunchAgent proof failed; custody retained: ${custodyPath}`,
        );
      }
      await fs.rm(fixtureHome, { recursive: true });
      releaseResources();
    })();
    onTestFinished(() => completion, 60_000);
    await completion;
  }, 120_000);

  it("restarts launchd service and keeps it running with a new pid", async () => {
    const launchEnv = launchEnvOrThrow(env);
    await initializeLaunchdRuntime(launchEnv, stdout);
    const before = await waitForRunningRuntime({ env: launchEnv });
    await restartLaunchAgent({ env: launchEnv, stdout });
    await expectRuntimePidReplaced({ env: launchEnv, previousPid: before.pid });
  }, 60_000);

  it("manages a named profile through the guarded host-service lifecycle", async () => {
    const testId = randomUUID().slice(0, 8);
    const profile = `launchd-int-${testId}`;
    const accountHome = os.userInfo().homedir;
    const stateDir = path.join(accountHome, `.openclaw-${profile}`);
    const profileEnv: GatewayServiceEnv = {
      HOME: accountHome,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: profile,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_LAUNCHD_LABEL: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
    };

    await withEnvAsync(profileEnv, async () => {
      const service = resolveGatewayService();
      try {
        await service.install({
          env: profileEnv,
          stdout,
          programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
        });
        const installed = await waitForRunningRuntime({ env: profileEnv });

        await service.stop({ env: profileEnv, stdout });
        await waitForNotRunningRuntime({ env: profileEnv });

        const startResult = await startGatewayService(service, { env: profileEnv, stdout });
        expect(startResult.outcome).toBe("started");
        const started = await waitForRunningRuntime({
          env: profileEnv,
          pidNot: installed.pid,
        });

        await service.restart({ env: profileEnv, stdout });
        await expectRuntimePidReplaced({ env: profileEnv, previousPid: started.pid });
      } finally {
        try {
          await service.uninstall({ env: profileEnv, stdout });
        } finally {
          await fs.rm(stateDir, { recursive: true, force: true });
        }
      }
    });
  }, 60_000);

  it("refuses a relocated OPENCLAW_HOME before launchd mutation", async () => {
    const testId = randomUUID().slice(0, 8);
    const relocatedHome = await fs.mkdtemp(
      path.join(os.tmpdir(), `openclaw-relocated-home-${testId}-`),
    );
    const relocatedEnv: GatewayServiceEnv = {
      HOME: os.userInfo().homedir,
      OPENCLAW_HOME: relocatedHome,
      OPENCLAW_PROFILE: `launchd-int-${testId}`,
    };

    try {
      await withEnvAsync(relocatedEnv, async () => {
        const service = resolveGatewayService();
        await expect(
          service.install({
            env: relocatedEnv,
            stdout,
            programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
          }),
        ).rejects.toThrow("service management skipped: non-default state dir or config path");
        await expect(fs.access(resolveLaunchAgentPlistPath(relocatedEnv))).rejects.toThrow();
      });
    } finally {
      await fs.rm(relocatedHome, { recursive: true, force: true });
    }
  });

  it("keeps LaunchAgent supervision after a raw SIGTERM", async () => {
    const launchEnv = launchEnvOrThrow(env);
    await initializeLaunchdRuntime(launchEnv, stdout);

    const before = await waitForRunningRuntime({ env: launchEnv });
    process.kill(before.pid, "SIGTERM");
    await expectRuntimePidReplaced({ env: launchEnv, previousPid: before.pid });
  }, 60_000);

  it("stops persistently without reinstall and starts later", async () => {
    const launchEnv = launchEnvOrThrow(env);
    await initializeLaunchdRuntime(launchEnv, stdout);

    const before = await waitForRunningRuntime({ env: launchEnv });
    await stopLaunchAgent({ env: launchEnv, stdout });
    await waitForNotRunningRuntime({ env: launchEnv });
    await startLaunchAgent({ env: launchEnv, stdout });
    await expectRuntimePidReplaced({ env: launchEnv, previousPid: before.pid });
  }, 60_000);

  it("stops persistently without reinstall and restarts later", async () => {
    const launchEnv = launchEnvOrThrow(env);
    await initializeLaunchdRuntime(launchEnv, stdout);

    const before = await waitForRunningRuntime({ env: launchEnv });
    await stopLaunchAgent({ env: launchEnv, stdout });
    await waitForNotRunningRuntime({ env: launchEnv });
    await restartLaunchAgent({ env: launchEnv, stdout });
    await expectRuntimePidReplaced({ env: launchEnv, previousPid: before.pid });
  }, 60_000);

  it("repairs a missing bootstrap without kickstarting the fresh LaunchAgent", async () => {
    const launchEnv = launchEnvOrThrow(env);
    const eventsPath = path.join(homeDir, "repair-probe.events.log");
    const scriptPath = path.join(homeDir, "repair-probe.cjs");
    await writeLaunchAgentProbeScript({ eventsPath, scriptPath });
    await installLaunchAgent({
      env: launchEnv,
      stdout,
      programArguments: [process.execPath, scriptPath],
    });
    await waitForRunningRuntime({ env: launchEnv });
    const bootout = spawnSync(
      "launchctl",
      ["bootout", resolveGuiDomain(), resolveLaunchAgentPlistPath(launchEnv)],
      { encoding: "utf8" },
    );
    expect(bootout.status).toBe(0);
    await waitForNotRunningRuntime({ env: launchEnv });
    await fs.access(resolveLaunchAgentPlistPath(launchEnv));
    await fs.writeFile(eventsPath, "", "utf8");

    const repair = await withTimeout(
      repairLaunchAgentBootstrap({ env: launchEnv }),
      STARTUP_TIMEOUT_MS,
      { message: "Timed out repairing launchd integration runtime" },
    );
    expect(repair).toEqual({ ok: true, status: "repaired" });
    await waitForRunningRuntime({ env: launchEnv });

    await new Promise((resolve) => {
      setTimeout(resolve, 1_500);
    });
    const events = await fs.readFile(eventsPath, "utf8");
    const trimmedEvents = events.trim();
    const lines = trimmedEvents.length > 0 ? trimmedEvents.split(/\r?\n/) : [];
    expect(lines.reduce((count, line) => count + (line.startsWith("start ") ? 1 : 0), 0)).toBe(1);
    const signalLines = lines.filter((line) => /^(SIGHUP|SIGINT|SIGTERM) /.test(line));
    expect(signalLines).toStrictEqual([]);
  }, 60_000);
});
