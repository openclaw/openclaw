// Launchd integration tests cover daemon CLI behavior in macOS-like scenarios.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { LOOPBACK_PORT_PROBE_HOSTS, probePortUsage } from "../infra/ports-probe.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { waitForPidToExit } from "../test-utils/process-tree.js";
import { withTimeout } from "../utils/with-timeout.js";
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
import { readGatewayServiceState, resolveGatewayService, startGatewayService } from "./service.js";

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

async function waitForRuntime(
  env: GatewayServiceEnv,
  ready: (runtime: Awaited<ReturnType<typeof readLaunchAgentRuntime>>) => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const runtime = await readLaunchAgentRuntime(env);
    lastStatus = runtime.status ?? "unknown";
    lastPid = runtime.pid;
    if (ready(runtime)) {
      return runtime;
    }
    await delay(WAIT_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for launchd runtime (status=${lastStatus}, pid=${lastPid ?? "none"})`,
  );
}

async function waitForRunningRuntime(params: {
  env: GatewayServiceEnv;
  pidNot?: number;
  timeoutMs?: number;
}): Promise<{ pid: number }> {
  const runtime = await waitForRuntime(
    params.env,
    ({ status, pid }) =>
      status === "running" && typeof pid === "number" && pid > 1 && pid !== params.pidNot,
    params.timeoutMs,
  );
  if (runtime.pid === undefined) {
    throw new Error("Expected running runtime PID");
  }
  return { pid: runtime.pid };
}

async function waitForNotRunningRuntime(params: { env: GatewayServiceEnv; timeoutMs?: number }) {
  await waitForRuntime(
    params.env,
    ({ status, pid }) => status !== "running" && pid === undefined,
    params.timeoutMs,
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
      await installLaunchAgent(idleLaunchAgent(launchEnv, stdout));
      await waitForRunningRuntime({ env: launchEnv });
    })(),
    STARTUP_TIMEOUT_MS,
    { message: "Timed out initializing launchd integration runtime" },
  );
}

function idleLaunchAgent(env: GatewayServiceEnv, stdout: PassThrough) {
  return {
    env,
    stdout,
    programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
  };
}

function isolatedLaunchEnv(home: string, id: string): GatewayServiceEnv {
  return {
    HOME: home,
    OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${id}`,
    OPENCLAW_LOG_PREFIX: `gateway-${id}`,
  };
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
    // #124296: real launchctl jobs and TCP probes, with no port-inspection mocks.
    const testId = randomUUID().slice(0, 8);
    const gatewayPort = 19_500 + (Number.parseInt(testId.slice(0, 4), 16) % 400);

    const gatewayHomeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `openclaw-launchd-int-gw-${testId}-`),
    );
    const gatewayEnv: GatewayServiceEnv = {
      ...isolatedLaunchEnv(gatewayHomeDir, `launchd-int-gw-${testId}`),
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    };

    const nodeHomeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `openclaw-launchd-int-node-${testId}-`),
    );
    const nodeEnv: GatewayServiceEnv = {
      ...isolatedLaunchEnv(nodeHomeDir, `launchd-int-node-${testId}`),
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

      // launchd can report running before the listener binds.
      await expect
        .poll(() => probePortUsage(gatewayPort, LOOPBACK_PORT_PROBE_HOSTS), {
          timeout: 10_000,
          interval: 100,
        })
        .toBe("busy");

      await installLaunchAgent(idleLaunchAgent(nodeEnv, stdout));
      const nodeBefore = await waitForRunningRuntime({ env: nodeEnv });

      await expect(probePortUsage(gatewayPort, LOOPBACK_PORT_PROBE_HOSTS)).resolves.toBe("busy");

      await expect(stopLaunchAgent({ env: nodeEnv, stdout })).resolves.not.toThrow();
      await waitForNotRunningRuntime({ env: nodeEnv });

      const gatewayStillRunning = await readLaunchAgentRuntime(gatewayEnv);
      expect(gatewayStillRunning.status).toBe("running");

      await installLaunchAgent(idleLaunchAgent(nodeEnv, stdout));
      await waitForRunningRuntime({ env: nodeEnv, pidNot: nodeBefore.pid });
      const nodeRunningBeforeRestart = await readLaunchAgentRuntime(nodeEnv);

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
    env = isolatedLaunchEnv(homeDir, `launchd-int-${testId}`);
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

  it("refuses real run-node publication while a sibling LaunchAgent holds checkout dist", async ({
    signal,
  }) => {
    const id = randomUUID().slice(0, 8);
    // openclaw-temp-dir: allow native service cleanup to retain evidence if retirement fails.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dist-fence-")),
    );
    const home = path.join(root, "home");
    const checkout = path.join(root, "openclaw-checkout");
    const dist = path.join(checkout, "dist");
    const entry = path.join(dist, "entry.cjs");
    const siblingProfile = `dist-sibling-${id}`;
    const selectedProfile = `dist-selected-${id}`;
    const siblingEnv: GatewayServiceEnv = {
      HOME: home,
      OPENCLAW_PROFILE: siblingProfile,
      OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${siblingProfile}`,
      OPENCLAW_LOG_PREFIX: siblingProfile,
    };
    let portClaim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
    let nativeAttempted = false;
    let nativeRetired = false;
    let servicePid: number | undefined;
    let commandAttempted = false;
    let commandSettled = false;
    await runQaGatewayFixture(
      async () => {
        await fs.mkdir(home);
        await fs.mkdir(dist, { recursive: true });
        await fs.mkdir(path.join(root, "tmp"));
        await fs.writeFile(
          path.join(checkout, "package.json"),
          '{"name":"openclaw","version":"0.0.0"}\n',
        );
        const files = new Map([
          ["entry.cjs", "setInterval(() => {}, 1000);\n"],
          ["retained-chunk.js", "export const retained = true;\n"],
        ]);
        for (const [name, bytes] of files) {
          await fs.writeFile(path.join(dist, name), bytes);
        }
        portClaim = await acquireTestPortBlock({ offsets: [0], signal });
        const selectedEnv: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: path.join(root, "tmp"),
          OPENCLAW_PROFILE: selectedProfile,
          OPENCLAW_STATE_DIR: path.join(home, `.openclaw-${selectedProfile}`),
          OPENCLAW_CONFIG_PATH: path.join(home, `.openclaw-${selectedProfile}`, "openclaw.json"),
          OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${selectedProfile}`,
          OPENCLAW_GATEWAY_PORT: String(portClaim.port),
          OPENCLAW_FORCE_BUILD: "1",
        };
        const selected = await readGatewayServiceState(resolveGatewayService(), {
          env: selectedEnv,
          requireEffective: true,
          requireLoadedCommand: true,
        });
        expect(selected).toMatchObject({
          installed: false,
          command: null,
          loadState: { status: "not-loaded" },
          runtime: { missingUnit: true },
        });
        expect(await probePortUsage(portClaim.port, LOOPBACK_PORT_PROBE_HOSTS)).toBe("free");
        await expect(fs.access(resolveLaunchAgentPlistPath(siblingEnv))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect((await readLaunchAgentRuntime(siblingEnv)).missingUnit).toBe(true);
        nativeAttempted = true;
        await installLaunchAgent({
          env: siblingEnv,
          environment: {
            HOME: home,
            OPENCLAW_PROFILE: siblingProfile,
            OPENCLAW_SERVICE_KIND: "gateway",
          },
          stdout,
          programArguments: [process.execPath, entry, "gateway"],
          workingDirectory: checkout,
        });
        const before = await waitForRunningRuntime({ env: siblingEnv });
        servicePid = before.pid;
        commandAttempted = true;
        const result = await runNodeScript(
          [path.resolve("scripts/run-node.mjs"), "models", "status"],
          selectedEnv,
          undefined,
          { cwd: checkout, signal, requireProcessTreeExit: true, maxBuffer: 128 * 1024 },
        );
        commandSettled = result.error === undefined && result.status !== null;
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(`Cannot replace ${checkout}: another managed Gateway`);
        expect(result.stderr).toContain(
          `/${siblingEnv.OPENCLAW_LAUNCHD_LABEL}" loaded from "${resolveLaunchAgentPlistPath(siblingEnv)}"`,
        );
        expect(result.stderr).toContain(
          "Stop that Gateway through its own service manager or Startup process",
        );
        expect(result.stderr).not.toContain("Building TypeScript");
        expect((await fs.readdir(dist)).toSorted()).toEqual([...files.keys()].toSorted());
        for (const [name, bytes] of files) {
          expect(await fs.readFile(path.join(dist, name), "utf8")).toBe(bytes);
        }
        expect((await waitForRunningRuntime({ env: siblingEnv })).pid).toBe(before.pid);
      },
      async () => {
        if (nativeAttempted) {
          await uninstallLaunchAgent({ env: siblingEnv, stdout });
          await waitForNotRunningRuntime({ env: siblingEnv });
          await expect(fs.access(resolveLaunchAgentPlistPath(siblingEnv))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect((await readLaunchAgentRuntime(siblingEnv)).missingUnit).toBe(true);
          if (servicePid === undefined) {
            throw new Error(
              `Synthetic service PID was never captured; cleanup remains unverified at ${root}`,
            );
          }
          expect(
            await waitForPidToExit(servicePid),
            `Synthetic service PID ${servicePid} has not exited; retained ${root}`,
          ).toBe(true);
        }
        nativeRetired = true;
      },
      async () => {
        await portClaim?.release();
      },
      async () => {
        if (nativeRetired && (!commandAttempted || commandSettled)) {
          await fs.rm(root, { recursive: true, force: true });
        }
      },
    );
  }, 90_000);

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
        await service.install(idleLaunchAgent(profileEnv, stdout));
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
        await expect(service.install(idleLaunchAgent(relocatedEnv, stdout))).rejects.toThrow(
          "service management skipped: non-default state dir or config path",
        );
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

    await delay(1_500);
    const events = await fs.readFile(eventsPath, "utf8");
    const trimmedEvents = events.trim();
    const lines = trimmedEvents.length > 0 ? trimmedEvents.split(/\r?\n/) : [];
    expect(lines.reduce((count, line) => count + (line.startsWith("start ") ? 1 : 0), 0)).toBe(1);
    const signalLines = lines.filter((line) => /^(SIGHUP|SIGINT|SIGTERM) /.test(line));
    expect(signalLines).toStrictEqual([]);
  }, 60_000);
});
