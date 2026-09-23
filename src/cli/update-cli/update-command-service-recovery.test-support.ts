import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi, type Mock } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { stampConfigWriteMetadata } from "../../config/io.meta.js";
import { buildLaunchAgentPlist } from "../../daemon/launchd-plist.js";
import { resolveLaunchAgentPlistPath } from "../../daemon/launchd-service-files.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { acquireGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { consumeGatewayRestartIntentPayloadSync } from "../../infra/restart-intent.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureEnv } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as runtimeUtils from "../../utils.js";
import { VERSION } from "../../version.js";
import { waitForGatewayUpdateRecovery } from "../daemon-cli/lifecycle-context.js";
import type { UpdateCommandOptions } from "./shared.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
  maybeRestartServiceAfterFailedMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
} from "./update-command-service.js";

const hostPlatform = process.platform;

function createServingOwnerFixture() {
  let lease: ReturnType<typeof acquireGatewayOwnerLease> | undefined;
  let coordinator: ReturnType<typeof acquireGatewayLifecycleCoordinator> | undefined;
  let env: NodeJS.ProcessEnv;
  const release = async () => {
    await lease?.release();
    lease = undefined;
    coordinator?.release();
    coordinator = undefined;
  };
  return {
    async publish(kind: "systemd" | "launchd" = "systemd") {
      expect(lease).toBeUndefined();
      env = { ...process.env };
      const platform = process.platform;
      // Use the real host's self identity while native service transport is simulated.
      mockProcessPlatform(hostPlatform);
      try {
        coordinator = acquireGatewayLifecycleCoordinator({
          databasePath: resolveOpenClawStateSqlitePath(env),
        });
        lease = acquireGatewayOwnerLease({
          env,
          port: 19305,
          mode: "supervised",
          supervisor: {
            kind,
            name: kind === "systemd" ? "openclaw-gateway.service" : "ai.openclaw.gateway",
          },
        });
        await lease.ready;
      } finally {
        mockProcessPlatform(platform);
      }
    },
    async restart() {
      if (lease) {
        expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({ reason: "gateway.restart" });
        await release();
      }
    },
    release,
  };
}

export async function createServiceActivationFixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-activation-")),
  );
  // Simulated manager identities must never address the host's shared handoff store.
  const runtimeTemp = path.join(root, ".runtime-temp");
  await fs.mkdir(runtimeTemp, { mode: 0o700 });
  vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(runtimeTemp);
  const readProcessStartTime = processIdentity.getFileLockProcessStartTime;
  // The service platform is simulated; only this live test process gets a fixed start identity.
  vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((pid, ...args) =>
    pid === process.pid ? 1_700_000_000 : readProcessStartTime(pid, ...args),
  );
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: root });
  const keys = [
    "HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SUDO_USER",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_PROFILE",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_SERVICE_KIND",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_UPDATE_IN_PROGRESS",
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR",
    "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
  ];
  const envSnapshot = captureEnv(keys);
  for (const key of keys) {
    delete process.env[key];
  }
  process.env.HOME = root;
  process.env.XDG_RUNTIME_DIR = path.join(root, ".runtime");
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
  // This fixture models an installed service even though its manager calls are simulated.
  const unitPath = path.join(root, ".config/systemd/user/openclaw-gateway.service");
  await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
  await fs.writeFile(unitPath, "[Service]\nExecStart=/fixture/openclaw gateway\n", { mode: 0o600 });
  const configPath = path.join(root, ".openclaw", "openclaw.json");
  await fs.mkdir(path.dirname(configPath), { mode: 0o700 });
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: VERSION, type: "module" }),
  );
  await fs.writeFile(path.join(root, "dist", "index.js"), "export {};\n");
  const worker = "dist/infra/update-candidate-state.worker.js";
  await fs.mkdir(path.dirname(path.join(root, worker)), { recursive: true });
  await fs.writeFile(
    path.join(root, worker),
    `import ${JSON.stringify(pathToFileURL(path.resolve(worker)).href)};\n`,
  );
  await writeRecoveryConfig(configPath, VERSION);
  return { root, configPath, envSnapshot, servingOwner: createServingOwnerFixture() };
}

export function readyRecoveryHealth(
  port: number,
  running: boolean,
): Awaited<
  ReturnType<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>
> {
  return {
    healthy: true,
    staleGatewayPids: [],
    runtime: { status: running ? "running" : "stopped", pid: running ? 4242 : undefined },
    gatewayBootId: "service-boot",
    portUsage: { port, status: "busy", listeners: [], hints: [] },
  };
}

export async function writeRecoveryConfig(configPath: string, version: string) {
  await fs.writeFile(
    configPath,
    JSON.stringify(stampConfigWriteMetadata({ gateway: { port: 19001 } }, undefined, version)),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
}

export function registerRecoveryTests(params: {
  root: () => string;
  configPath: () => string;
  run: () => NonNullable<UpdateCommandOptions["run"]>;
  mocks: {
    launchctl: Mock<typeof import("../../daemon/launchd-exec.js").execLaunchctl>;
    health: Mock<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>;
    capability: Mock<
      typeof import("../../daemon/systemd-definition-mutation.js").readSystemdDefinitionMutationCapability
    >;
    command: Mock<typeof import("../../daemon/systemd.js").readSystemdServiceExecStart>;
    child: Mock<typeof import("../../process/exec.js").runCommandWithTimeout>;
    error: Mock;
    restart: Mock;
    ports: Mock<typeof import("../../infra/ports-inspect.js").inspectPortUsage>;
    call: Mock<(opts: CallGatewayOptions) => Promise<unknown>>;
    configSnapshot: Mock<() => Promise<void>>;
    running: boolean;
    events: string[];
  };
}): void {
  it.each(["detached recovery", "failed-update recovery"] as const)(
    "%s waits through loaded launchd throttling using the real health owner",
    async (caller) => {
      const root = params.root();
      const mocks = params.mocks;
      mockProcessPlatform("darwin");
      let nowMs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => nowMs);
      vi.spyOn(runtimeUtils, "sleep").mockImplementation(async (ms) => {
        nowMs += ms;
      });
      const plistPath = resolveLaunchAgentPlistPath(process.env);
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(
        plistPath,
        buildLaunchAgentPlist({
          label: "ai.openclaw.gateway",
          programArguments: [
            process.execPath,
            path.join(root, "dist/index.js"),
            "gateway",
            "--port",
            "19305",
          ],
          stdoutPath: path.join(root, "gateway.log"),
          stderrPath: path.join(root, "gateway.err"),
          environment: { HOME: root },
        }),
      );
      let activated = false;
      mocks.launchctl.mockImplementation(async (args) => {
        expect(args[0]).toBe("print");
        const state = !activated || nowMs < 4000 || nowMs >= 14_000 ? "running" : "stopped";
        return {
          code: 0,
          stdout: `state = ${state}\n${activated && state === "running" ? `pid = ${nowMs < 4000 ? 4200 : 4300}\n` : ""}`,
          stderr: "",
          termination: "exit",
        };
      });
      mocks.ports.mockImplementation(async (port) => ({
        port,
        status: nowMs < 14_000 ? "free" : "busy",
        listeners: nowMs < 14_000 ? [] : [{ pid: 4300, command: "openclaw-gateway" }],
        hints: [],
      }));
      mocks.call.mockImplementation(
        gatewayHealthResponse({
          server: { version: VERSION, buildId: "recovered-build", bootId: "recovered-boot" },
        }),
      );
      const { waitForGatewayHealthyRestart } = await vi.importActual<
        typeof import("../daemon-cli/restart-health.js")
      >("../daemon-cli/restart-health.js");
      mocks.health.mockImplementation(waitForGatewayHealthyRestart);
      if (caller === "detached recovery") {
        activated = true;
        await expect(
          waitForGatewayUpdateRecovery(VERSION, "recovered-build"),
        ).resolves.toMatchObject({
          healthy: true,
          waitOutcome: "healthy",
          elapsedMs: 19_500,
          runtime: { status: "running", pid: 4300 },
        });
      } else {
        const state = await readGatewayServiceState(resolveGatewayService(), {
          requireEffective: true,
        });
        const verdict = await revalidateManagedGatewayServiceAfterUpdate({ state, root });
        expect(verdict.kind).toBe("owned");
        mocks.child.mockImplementation(async (args) => {
          expect(args).toContain("restart");
          activated = true;
          return {
            code: 0,
            stdout: JSON.stringify({ action: "restart", ok: true, result: "restarted" }),
            stderr: "",
            signal: null,
            killed: false,
            termination: "exit",
          };
        });
        await expect(
          maybeRestartServiceAfterFailedMutableUpdate({
            preManagedServiceStop: {
              stopped: true,
              inspected: true,
              runtimeInspected: true,
              running: state.running,
              serviceEnv: state.env,
              serviceUpdateVerdict: verdict,
            },
            recovery: { serviceRestartSafe: true, version: VERSION, buildId: "recovered-build" },
            jsonMode: true,
          }),
        ).resolves.toBe("healthy");
        expect(mocks.child).toHaveBeenCalledOnce();
      }
      expect(mocks.health).toHaveBeenCalledOnce();
      expect(mocks.health.mock.calls[0]?.[0].supervisorKeepsAlive).toBeUndefined();
      await expect(mocks.health.mock.results[0]?.value).resolves.toMatchObject({
        healthy: true,
        waitOutcome: "healthy",
        elapsedMs: 19_500,
        gatewayBootId: "recovered-boot",
      });
      expect(nowMs).toBe(19_500);
      expect(mocks.restart).not.toHaveBeenCalled();
    },
  );

  it.each([
    { startup: "fast", readyAfterMs: 0, needsRecovery: false },
    { startup: "slow", readyAfterMs: 20_000, needsRecovery: false },
    { startup: "unready", readyAfterMs: Infinity, needsRecovery: false },
    { startup: "wrong version", readyAfterMs: 0, needsRecovery: true },
  ])(
    "verifies the $startup refresh before deciding on recovery",
    async ({ startup, readyAfterMs, needsRecovery }) => {
      const root = params.root();
      const mocks = params.mocks;
      let nowMs = 0;
      let recovering = false;
      vi.spyOn(performance, "now").mockImplementation(() => nowMs);
      vi.spyOn(runtimeUtils, "sleep").mockImplementation(async (ms) => {
        nowMs += ms;
      });
      mocks.capability.mockResolvedValue({ kind: "writable" });
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root,
        shouldRestart: true,
        jsonMode: true,
      });
      expect(before.serviceUpdateVerdict).toMatchObject({ kind: "owned", refreshDefinition: true });

      mocks.child.mockImplementation(async (args) => {
        if (args.includes("restart")) {
          recovering = true;
          mocks.events.push("recovery restart");
        } else {
          expect(args).toContain("install");
          mocks.events.push("refresh activation");
        }
        mocks.running = true;
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      mocks.configSnapshot.mockResolvedValue(undefined);
      mocks.ports.mockImplementation(async (port) => {
        const ready = recovering || nowMs >= readyAfterMs;
        return {
          port,
          status: ready ? "busy" : "free",
          listeners: ready ? [{ pid: 4242, command: "openclaw-gateway" }] : [],
          hints: [],
        };
      });
      mocks.call.mockImplementation(async (opts) =>
        gatewayHealthResponse({
          server: {
            version: startup === "wrong version" && !recovering ? "2026.1.1" : VERSION,
            connId: "fixture",
            bootId: "service-boot",
          },
        })(opts),
      );
      const { waitForGatewayHealthyRestart } = await vi.importActual<
        typeof import("../daemon-cli/restart-health.js")
      >("../daemon-cli/restart-health.js");
      const healthResults: Awaited<ReturnType<typeof waitForGatewayHealthyRestart>>[] = [];
      mocks.health.mockImplementation(async (healthParams) => {
        const health = await waitForGatewayHealthyRestart(healthParams);
        healthResults.push(health);
        mocks.events.push(`health: ${health.waitOutcome}`);
        return health;
      });

      const result: UpdateRunResult = {
        status: "ok",
        mode: "npm",
        root,
        steps: [],
        durationMs: 0,
        before: { version: "2026.1.1" },
        after: { version: VERSION },
      };
      const activated = await maybeRestartService({
        shouldRestart: true,
        result,
        opts: { json: true, run: params.run() },
        refreshServiceEnv: true,
        serviceInstallEnv: process.env,
        serviceUpdateVerdict: before.serviceUpdateVerdict,
        serviceManagerUid: before.serviceManagerUid,
        serviceEnv: before.serviceEnv,
        gatewayPort: 19305,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1_000,
      });

      const pending = startup === "slow" || startup === "unready";
      expect(activated).toBe(pending ? "readiness-pending" : "ok");
      if (pending) {
        const run = params.run();
        expect(completeUpdateCommandRun(result, run)).toMatchObject({
          status: "skipped",
          reason: "gateway-readiness-unverified",
        });
        expect(getUpdateRun(run.runId, { env: run.env })).toMatchObject({
          status: "skipped",
          reason: "gateway-readiness-unverified",
          confirmedAtMs: null,
          verification: { serviceRunning: true, pid: 4242, readyz: false },
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "warning:gateway verification",
              detail: expect.stringContaining("Keep recovery backups"),
            }),
          ]),
        });
        expect(mocks.running).toBe(true);
      }
      expect(mocks.events).toEqual([
        "native stop",
        "refresh activation",
        ...(needsRecovery
          ? [
              `health: ${startup === "wrong version" ? "version-mismatch" : "timeout"}`,
              "recovery restart",
            ]
          : []),
        pending ? "health: timeout" : "health: healthy",
      ]);
      expect(mocks.restart).not.toHaveBeenCalled();
      if (startup === "unready" || startup === "slow") {
        expect(healthResults[0]?.elapsedMs).toBe(6_500);
      } else if (!needsRecovery) {
        expect(nowMs).toBeGreaterThanOrEqual(readyAfterMs + 5_500);
      }
    },
  );

  it.each(["healthy", "unready", "exited", "cleanup"] as const)(
    "failed-update recovery requires canonical readiness after start acceptance (%s)",
    async (outcome) => {
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: params.root(),
        shouldRestart: true,
        jsonMode: true,
      });
      params.mocks.health.mockImplementation(async ({ port, expectedVersion }) => ({
        healthy: outcome === "healthy",
        staleGatewayPids: [],
        gatewayVersion: expectedVersion,
        runtime: { status: outcome === "exited" ? "stopped" : "running" },
        portUsage: {
          port,
          status: outcome === "healthy" ? "busy" : "free",
          listeners: [],
          hints: [],
        },
      }));
      const cleanup = new CommandProcessCleanupError();
      if (outcome === "cleanup") {
        params.mocks.health.mockRejectedValueOnce(cleanup);
      }
      const pending = maybeRestartServiceAfterFailedMutableUpdate({
        preManagedServiceStop: before,
        jsonMode: true,
        recovery: { serviceRestartSafe: true, version: VERSION, buildId: "restored-git-build" },
      });
      if (outcome === "cleanup") {
        await expect(pending).rejects.toBe(cleanup);
      } else {
        await expect(pending).resolves.toBe(outcome === "healthy" ? "healthy" : "failed");
      }
      expect(params.mocks.health).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedBuildId: "restored-git-build",
          requireRunningService: true,
        }),
      );
    },
  );
  it.each([
    "foreign",
    "metadata",
    "unit",
    "unavailable",
    "replacement root",
    "profile",
    "before activation",
    "after readiness",
  ])("revalidates stale-parent failed-update recovery after %s changes", async (change) => {
    const root = params.root();
    const configPath = params.configPath();
    const mocks = params.mocks;
    mocks.capability.mockResolvedValue({ kind: "writable" });
    const before = await maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "package",
      root,
      shouldRestart: true,
      jsonMode: true,
    });
    expect(before.stopped).toBe(true);
    await writeRecoveryConfig(configPath, "9999.1.1");
    process.env.OPENCLAW_GATEWAY_PORT = "19999";
    const command = await mocks.command(process.env);
    if (!command) {
      throw new Error("missing fixture command");
    }
    if (change === "unavailable") {
      mocks.command.mockRejectedValue(new Error("manager unavailable"));
    } else {
      const foreign = path.join(root, "foreign");
      await fs.mkdir(path.join(foreign, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(foreign, "package.json"),
        JSON.stringify({ name: "openclaw", version: VERSION }),
      );
      await fs.writeFile(path.join(foreign, "dist", "index.js"), "export {};\n");
      const replacement = {
        ...command,
        programArguments: [
          process.execPath,
          path.join(
            ["foreign", "replacement root"].includes(change) ? foreign : root,
            "dist",
            "index.js",
          ),
          "gateway",
          "--port",
          "19002",
        ],
        environment: {
          HOME: root,
          OPENCLAW_PROFILE: "default",
          OPENCLAW_STATE_DIR: path.dirname(configPath),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SYSTEMD_UNIT:
            change === "unit" ? "openclaw-other.service" : "openclaw-gateway.service",
          ...(change === "profile"
            ? {
                OPENCLAW_PROFILE: "second",
                OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-second.service",
                OPENCLAW_STATE_DIR: path.join(root, ".openclaw-second"),
                OPENCLAW_CONFIG_PATH: path.join(root, ".openclaw-second", "openclaw.json"),
              }
            : {}),
        },
      };
      if (change === "after readiness") {
        mocks.health.mockImplementationOnce(async ({ port }) => {
          mocks.command.mockResolvedValue(replacement);
          return readyRecoveryHealth(port, true);
        });
      } else {
        mocks.command.mockResolvedValue(replacement);
        if (change === "before activation") {
          mocks.command.mockResolvedValueOnce(command);
        }
      }
    }
    mocks.events.push("update failed after definition changed");
    const recovered = await maybeRestartServiceAfterFailedMutableUpdate({
      recovery: { serviceRestartSafe: true, version: VERSION },
      preManagedServiceStop: before,
      jsonMode: true,
    });
    if (change === "metadata") {
      expect(mocks.child).toHaveBeenCalledOnce();
      expect(mocks.child.mock.calls[0]?.[0]).toContain("--preserve-definition");
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.child.mock.calls[0]?.[1]).toMatchObject({ baseEnv: {} });
      expect(mocks.child.mock.calls[0]?.[1]).not.toHaveProperty("env.OPENCLAW_GATEWAY_PORT");
    } else if (change === "after readiness") {
      expect(recovered).toBe("failed");
      expect(mocks.child).toHaveBeenCalledOnce();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.error.mock.calls.flat().join("\n")).toContain(
        "ownership or manager identity changed",
      );
    } else {
      expect(mocks.child).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.error.mock.calls.flat().join("\n")).toContain("Failed to restart");
      expect(mocks.events).toEqual(["native stop", "update failed after definition changed"]);
    }
  });
}
