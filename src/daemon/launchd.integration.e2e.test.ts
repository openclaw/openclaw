import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { withTimeout } from "../infra/fs-safe.js";
import { LOOPBACK_PORT_PROBE_HOSTS, probePortUsage } from "../infra/ports-probe.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { waitForPidToExit } from "../test-utils/process-tree.js";
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

const STARTUP_TIMEOUT_MS = 45_000;
const GUI_DOMAIN = `gui/${process.getuid?.() ?? 501}`;

function canRunLaunchdIntegration(): boolean {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    return false;
  }
  const probe = spawnSync("launchctl", ["print", GUI_DOMAIN], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

const describeLaunchdIntegration = canRunLaunchdIntegration() ? describe : describe.skip;

async function waitForRuntime(
  env: GatewayServiceEnv,
  ready: (runtime: Awaited<ReturnType<typeof readLaunchAgentRuntime>>) => boolean,
) {
  const deadline = Date.now() + 30_000;
  let runtime: Awaited<ReturnType<typeof readLaunchAgentRuntime>> | undefined;
  while (Date.now() < deadline) {
    runtime = await readLaunchAgentRuntime(env);
    if (ready(runtime)) {
      return runtime;
    }
    await delay(200);
  }
  throw new Error(
    `Timed out waiting for launchd runtime (status=${runtime?.status ?? "unknown"}, pid=${runtime?.pid ?? "none"})`,
  );
}

async function waitForRunningRuntime(env: GatewayServiceEnv, pidNot?: number) {
  const runtime = await waitForRuntime(
    env,
    ({ status, pid }) =>
      status === "running" && typeof pid === "number" && pid > 1 && pid !== pidNot,
  );
  return { pid: expectDefined(runtime.pid, "running runtime PID") };
}

async function waitForNotRunningRuntime(env: GatewayServiceEnv) {
  await waitForRuntime(env, ({ status, pid }) => status !== "running" && pid === undefined);
}

async function launchFixture(id: string, overrides: GatewayServiceEnv = {}) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${id}-`));
  const env: GatewayServiceEnv = {
    HOME: homeDir,
    OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${id}`,
    OPENCLAW_LOG_PREFIX: `gateway-${id}`,
    ...overrides,
  };
  return { homeDir, env };
}

async function expectRuntimePidReplaced(env: GatewayServiceEnv, previousPid: number) {
  // The polling predicate requires a live PID distinct from the previous process.
  await waitForRunningRuntime(env, previousPid);
  await fs.access(resolveLaunchAgentPlistPath(env));
}

describeLaunchdIntegration("launchd integration", () => {
  let env: GatewayServiceEnv;
  let homeDir = "";
  const stdout = new PassThrough();
  const launchArgs = (
    launchEnv: GatewayServiceEnv,
    programArguments = [process.execPath, "-e", "setInterval(() => {}, 1000);"],
  ) => ({ env: launchEnv, stdout, programArguments });

  it("recovers registered services after their plists are deleted", async () => {
    const fixture = await launchFixture(`missing-plist-${randomUUID().slice(0, 8)}`);
    const plist = resolveLaunchAgentPlistPath(fixture.env);
    try {
      await installLaunchAgent(launchArgs(fixture.env));
      await waitForRunningRuntime(fixture.env);
      await fs.unlink(plist);

      await uninstallLaunchAgent({ env: fixture.env, stdout });
      await waitForNotRunningRuntime(fixture.env);

      await installLaunchAgent(launchArgs(fixture.env));
      const previous = await waitForRunningRuntime(fixture.env);
      await fs.unlink(plist);
      const warnings: string[] = [];

      await installLaunchAgent({
        ...launchArgs(fixture.env),
        warn: (message) => warnings.push(message),
      });

      await expectRuntimePidReplaced(fixture.env, previous.pid);
      expect(warnings.some((message) => message.includes("plist is missing"))).toBe(true);
    } finally {
      await uninstallLaunchAgent({ env: fixture.env, stdout });
      await fs.rm(fixture.homeDir, { recursive: true, force: true });
    }
  });

  it("real launchctl: node-host LaunchAgent stop/restart survives a co-located busy Gateway port (#124296)", async () => {
    // #124296: real launchctl jobs and TCP probes, with no port-inspection mocks.
    const testId = randomUUID().slice(0, 8);
    const gatewayPort = 19_500 + (Number.parseInt(testId.slice(0, 4), 16) % 400);

    const gateway = await launchFixture(`launchd-int-gw-${testId}`, {
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    });

    const node = await launchFixture(`launchd-int-node-${testId}`, {
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    });

    try {
      await installLaunchAgent(
        launchArgs(gateway.env, [
          process.execPath,
          "-e",
          `require("node:http").createServer((_req,res)=>res.end("ok")).listen(${gatewayPort}, "127.0.0.1", () => {}); setInterval(() => {}, 1000);`,
        ]),
      );
      await waitForRunningRuntime(gateway.env);

      // launchd can report running before the listener binds.
      await expect
        .poll(() => probePortUsage(gatewayPort, LOOPBACK_PORT_PROBE_HOSTS), {
          timeout: 10_000,
          interval: 100,
        })
        .toBe("busy");

      await installLaunchAgent(launchArgs(node.env));
      const nodeBefore = await waitForRunningRuntime(node.env);

      await expect(probePortUsage(gatewayPort, LOOPBACK_PORT_PROBE_HOSTS)).resolves.toBe("busy");

      await expect(stopLaunchAgent({ env: node.env, stdout })).resolves.not.toThrow();
      await waitForNotRunningRuntime(node.env);

      expect(await readLaunchAgentRuntime(gateway.env)).toMatchObject({ status: "running" });

      await installLaunchAgent(launchArgs(node.env));
      await waitForRunningRuntime(node.env, nodeBefore.pid);
      const nodeRunningBeforeRestart = await readLaunchAgentRuntime(node.env);

      await expect(probePortUsage(gatewayPort, LOOPBACK_PORT_PROBE_HOSTS)).resolves.toBe("busy");

      await expect(restartLaunchAgent({ env: node.env, stdout })).resolves.not.toThrow();
      await expectRuntimePidReplaced(node.env, nodeRunningBeforeRestart.pid ?? nodeBefore.pid);

      expect(await readLaunchAgentRuntime(gateway.env)).toMatchObject({ status: "running" });
    } finally {
      await uninstallLaunchAgent({ env: node.env, stdout }).catch(() => {});
      await uninstallLaunchAgent({ env: gateway.env, stdout }).catch(() => {});
      await fs.rm(node.homeDir, { recursive: true, force: true });
      await fs.rm(gateway.homeDir, { recursive: true, force: true });
    }
  }, 90_000);

  beforeAll(async () => {
    ({ homeDir, env } = await launchFixture(`launchd-int-${randomUUID().slice(0, 8)}`));
  });

  afterAll(async () => {
    if (env) {
      await uninstallLaunchAgent({ env, stdout }).catch(() => {});
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
          ...launchArgs(siblingEnv, [process.execPath, entry, "gateway"]),
          environment: {
            HOME: home,
            OPENCLAW_PROFILE: siblingProfile,
            OPENCLAW_SERVICE_KIND: "gateway",
          },
          workingDirectory: checkout,
        });
        const before = await waitForRunningRuntime(siblingEnv);
        servicePid = before.pid;
        commandAttempted = true;
        const result = await runNodeScript(
          [path.resolve("scripts/run-node.mjs"), "models", "status"],
          selectedEnv,
          undefined,
          { cwd: checkout, signal, requireProcessTreeExit: true, maxBuffer: 128 * 1024 },
        );
        commandSettled = result.error === undefined && result.status !== null;
        expect(result, result.stderr).toMatchObject({ error: undefined, status: 1 });
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
        expect((await waitForRunningRuntime(siblingEnv)).pid).toBe(before.pid);
      },
      async () => {
        if (nativeAttempted) {
          await uninstallLaunchAgent({ env: siblingEnv, stdout });
          await waitForNotRunningRuntime(siblingEnv);
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

  it.each(["restart", "SIGTERM", "stop/start", "stop/restart"] as const)(
    "keeps launchd supervision and replaces the PID after %s",
    async (action) => {
      const before = await withTimeout(
        (async () => {
          await installLaunchAgent(launchArgs(env));
          return waitForRunningRuntime(env);
        })(),
        STARTUP_TIMEOUT_MS,
        { message: "Timed out initializing launchd integration runtime" },
      );
      if (action.startsWith("stop/")) {
        await stopLaunchAgent({ env, stdout });
        await waitForNotRunningRuntime(env);
      }
      if (action === "SIGTERM") {
        process.kill(before.pid, "SIGTERM");
      } else {
        const activate = action === "stop/start" ? startLaunchAgent : restartLaunchAgent;
        await activate({ env, stdout });
      }
      await expectRuntimePidReplaced(env, before.pid);
    },
    60_000,
  );

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
        await service.install(launchArgs(profileEnv));
        const installed = await waitForRunningRuntime(profileEnv);

        await service.stop({ env: profileEnv, stdout });
        await waitForNotRunningRuntime(profileEnv);

        const startResult = await startGatewayService(service, { env: profileEnv, stdout });
        expect(startResult.outcome).toBe("started");
        const started = await waitForRunningRuntime(profileEnv, installed.pid);

        await service.restart({ env: profileEnv, stdout });
        await expectRuntimePidReplaced(profileEnv, started.pid);
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
        await expect(service.install(launchArgs(relocatedEnv))).rejects.toThrow(
          "service management skipped: non-default state dir or config path",
        );
        await expect(fs.access(resolveLaunchAgentPlistPath(relocatedEnv))).rejects.toThrow();
      });
    } finally {
      await fs.rm(relocatedHome, { recursive: true, force: true });
    }
  });

  it("repairs a missing bootstrap without kickstarting the fresh LaunchAgent", async () => {
    const eventsPath = path.join(homeDir, "repair-probe.events.log");
    const scriptPath = path.join(homeDir, "repair-probe.cjs");
    await fs.writeFile(
      scriptPath,
      `const fs = require("node:fs");
const eventsPath = ${JSON.stringify(eventsPath)};
fs.appendFileSync(eventsPath, \`start \${process.pid}\\n\`);
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    fs.appendFileSync(eventsPath, \`\${signal} \${process.pid}\\n\`);
    process.exit(0);
  });
}
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await installLaunchAgent(launchArgs(env, [process.execPath, scriptPath]));
    await waitForRunningRuntime(env);
    const bootout = spawnSync(
      "launchctl",
      ["bootout", GUI_DOMAIN, resolveLaunchAgentPlistPath(env)],
      { encoding: "utf8" },
    );
    expect(bootout.status).toBe(0);
    await waitForNotRunningRuntime(env);
    await fs.access(resolveLaunchAgentPlistPath(env));
    await fs.writeFile(eventsPath, "", "utf8");

    const repair = await withTimeout(repairLaunchAgentBootstrap({ env }), STARTUP_TIMEOUT_MS, {
      message: "Timed out repairing launchd integration runtime",
    });
    expect(repair).toEqual({ ok: true, status: "repaired" });
    await waitForRunningRuntime(env);

    await delay(1_500);
    const events = await fs.readFile(eventsPath, "utf8");
    const trimmedEvents = events.trim();
    const lines = trimmedEvents.length > 0 ? trimmedEvents.split(/\r?\n/) : [];
    expect(lines.reduce((count, line) => count + (line.startsWith("start ") ? 1 : 0), 0)).toBe(1);
    const signalLines = lines.filter((line) => /^(SIGHUP|SIGINT|SIGTERM) /.test(line));
    expect(signalLines).toStrictEqual([]);
  }, 60_000);
});
