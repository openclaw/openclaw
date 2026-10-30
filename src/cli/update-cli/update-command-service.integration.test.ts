// Native transport is simulated; update-command-service-custody.test.ts covers receiver custody.
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { buildLaunchAgentPlist } from "../../daemon/launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "../../daemon/launchd-plist.test-support.js";
import {
  resolveLaunchAgentPlistPath,
  resolveLaunchAgentEnvironmentReadOptions,
  resolveLaunchAgentEnvWrapperPath,
} from "../../daemon/launchd-service-files.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { createSqliteReadOnlyWorkerScope } from "../../infra/sqlite-readonly-worker.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as runtimeUtils from "../../utils.js";
import { VERSION } from "../../version.js";
import { runDaemonRestart } from "../daemon-cli/lifecycle.js";
import { addGatewayServiceCommands } from "../daemon-cli/register-service-commands.js";
import * as startRepair from "../daemon-cli/start-repair.js";
import type { UpdateCommandOptions } from "./shared.js";
import { expectNoCalls as expectUncalled } from "./update-boundary.test-support.js";
import { registerGenerationRecoveryTests } from "./update-command-generation.test-support.js";
import { registerRestartOutcomeTests } from "./update-command-restart-outcome.test-support.js";
import { stubNodeRuntime } from "./update-command-runtime-recovery.test-support.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";
import { assertGatewayServiceManagementAllowedForUpdate } from "./update-command-service-plan.js";
import {
  createServiceActivationFixture,
  readyRecoveryHealth,
  serviceUpdateResult,
  registerRecoveryTests,
  writeRecoveryConfig,
} from "./update-command-service-recovery.test-support.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-revalidation.js";
import { registerPackageRootRollbackTests } from "./update-command-service-rollback.test-support.js";
import {
  preservedActivationCases,
  registerInstallRootTransitionTests,
  registerPluginMaintenanceTests,
} from "./update-command-service-transition.test-support.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
} from "./update-command-service.js";

const mocks = vi.hoisted(() => ({
  launchctl: vi.fn<typeof import("../../daemon/launchd-exec.js").execLaunchctl>(),
  terminateStale: vi.fn(async (pids: number[]) => pids),
  running: true,
  loaded: true,
  managerUid: 2001 as number | undefined,
  listenerPids: vi.fn(() => [4242]),
  ports: vi.fn<typeof import("../../infra/ports-inspect.js").inspectPortUsage>(),
  call: vi.fn<(opts: import("../../gateway/call.js").CallGatewayOptions) => Promise<unknown>>(),
  signal: vi.fn(),
  events: [] as string[],
  stopAllowances: [] as Array<string | undefined>,
  command: vi.fn<typeof import("../../daemon/systemd.js").readSystemdServiceExecStart>(),
  restart: vi.fn(async () => {
    await servingOwner.restart();
    mocks.events.push("native restart");
    mocks.running = true;
    return { outcome: "completed" as const };
  }),
  start: vi.fn(),
  install: vi.fn(),
  child: vi.fn<typeof import("../../process/exec.js").runCommandWithTimeout>(),
  health: vi.fn<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>(),
  doctor: vi.fn(),
  configSnapshot: vi.fn<() => Promise<void>>(),
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
  writeJson: vi.fn(),
  capability:
    vi.fn<
      typeof import("../../daemon/systemd-definition-mutation.js").readSystemdDefinitionMutationCapability
    >(),
}));

vi.mock("../../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-exec.js")>()),
  execLaunchctl: mocks.launchctl,
}));
// mock-isolation: Simulate service ownership without inspecting the host's launchd service.
vi.mock("../../daemon/launchd-current-service.js", () => ({
  isCurrentProcessLaunchdServiceLabel: () => false,
  isCurrentProcessInsideLaunchdService: async () => false,
}));
vi.mock("../../daemon/service-process-membership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service-process-membership.js")>()),
  // The simulated manager's Gateway PID has no native cgroup on the test host.
  inspectServiceProcessMembershipSync: (pid: number) => (pid === 4242 ? "outside" : "unknown"),
}));
vi.mock("../../daemon/launchd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: async () => {},
  inspectSystemLaunchDaemonOwnership: async (label: string) => ({
    status: "absent",
    serviceTarget: `system/${label}`,
  }),
}));
vi.mock("../../infra/restart-stale-pids.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-stale-pids.js")>()),
  cleanStaleGatewayProcessesSync: () => [],
  // Simulated service platforms must not read the host's native ancestry.
  inspectSelfAndAncestorPidsSync: () => ({
    pids: new Set([process.pid, process.ppid, 1]),
    complete: true,
  }),
  terminateStaleGatewayPids: mocks.terminateStale,
}));
vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: mocks.ports,
}));

vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: mocks.call,
}));

vi.mock("../../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd.js")>()),
  readSystemdServiceExecStart: mocks.command,
  readSystemdServiceRuntime: async () => ({
    systemd: { managerUid: mocks.managerUid },
    status: mocks.running ? "running" : "stopped",
    ...(mocks.running ? { pid: 4242 } : {}),
  }),
  isSystemdServiceEnabled: async () => mocks.loaded,
  findInstalledSystemdGatewayScope: async () => null,
  isSystemdUserServiceAvailable: async () => true,
  stopSystemdService: async () => {
    mocks.stopAllowances.push(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS);
    mocks.events.push("native stop");
    mocks.running = false;
  },
  restartSystemdService: mocks.restart,
  startSystemdService: mocks.start,
  installSystemdService: mocks.install,
}));
vi.mock("../../daemon/systemd-user-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-user-transport.js")>()),
  resolveSystemdUserTransport: async () => undefined,
}));
vi.mock("./update-command-service-drain.js", () => ({
  withGatewayMaintenanceDrain: async (_params: unknown, stop: () => Promise<unknown>) =>
    await stop(),
}));
vi.mock("../../daemon/systemd-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-maintenance.js")>()),
  prepareSystemdGatewayMaintenance: async () => ({ kind: "unchanged" }),
}));
vi.mock("../../daemon/systemd-definition-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-definition-mutation.js")>()),
  readSystemdDefinitionMutationCapability: mocks.capability,
}));
// These platform-mocked lifecycle fixtures do not own a real updater process.
// Keep the real command/result implementation, but model only its native transport.
// The real caller's missing/unregistered executor refusals have process tests.
vi.mock("./update-command-service-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./update-command-service-command.js")>();
  return {
    ...actual,
    runUpdatedInstallGatewayCommand: (
      ...[params, action]: Parameters<typeof actual.runUpdatedInstallGatewayCommand>
    ) => actual.runUpdatedInstallGatewayCommand({ ...params, opts: {} }, action),
  };
});
vi.mock("../../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process/exec.js")>();
  const versionProbe = [
    "busctl",
    "--user",
    "--auto-start=no",
    "get-property",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "Version",
  ];
  return {
    ...actual,
    runCommandWithTimeout: (...args: Parameters<typeof actual.runCommandWithTimeout>) => {
      const [argv, options] = args;
      if (argv[0] === "systemctl") {
        expect(argv).toEqual(["systemctl", "--user", "daemon-reload"]);
        expect(options).toMatchObject({ baseEnv: { HOME: root } });
        expect(mocks.running).toBe(false);
        mocks.events.push("native daemon-reload");
        return Promise.resolve(commandResult());
      }
      if (argv.length === versionProbe.length && versionProbe.every((arg, i) => argv[i] === arg)) {
        return Promise.resolve(commandResult({ stdout: 's "252.39"' }));
      }
      return mocks.child(...args);
    },
    runExec: vi.fn(
      async (_command: string, args: string[], options: { input: string | Uint8Array }) =>
        decodeLaunchAgentPlistFixture(options.input, args[1]),
    ),
  };
});
vi.mock("../../infra/gateway-processes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-processes.js")>()),
  findVerifiedGatewayListenerPidsOnPortSync: mocks.listenerPids,
  signalVerifiedGatewayPidSync: mocks.signal,
}));
vi.mock("../../commands/doctor.js", () => ({ doctorCommand: mocks.doctor }));
vi.mock("./update-command-config-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config-snapshot.js")>()),
  createUpdateConfigSnapshot: mocks.configSnapshot,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: {
    log: mocks.log,
    error: mocks.error,
    exit: mocks.exit,
    writeJson: mocks.writeJson,
  },
}));
vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.health,
  waitForGatewayHttpReadiness: async () => ({ healthz: 200, readyz: 200 }),
}));
vi.mock("./update-command-convergence.js", () => ({
  convergeUpdatePlugins: async (params: { result: unknown }) => ({
    resultWithPostUpdate: params.result,
  }),
}));
vi.mock("../daemon-cli/lifecycle-audit.js", () => ({
  appendServiceLifecycleRepairAudit: vi.fn(),
  createServiceLifecycleMutationAudit: vi.fn(),
  createGatewayLifecycleMutationAudit: vi.fn(),
}));

let root: string;
let configPath: string;
let run: NonNullable<UpdateCommandOptions["run"]>;
let envSnapshot: Awaited<ReturnType<typeof createServiceActivationFixture>>["envSnapshot"];
let servingOwner: Awaited<ReturnType<typeof createServiceActivationFixture>>["servingOwner"];
const writeConfig = (version: string) => writeRecoveryConfig(configPath, version);
const gatewayArgs = (port = "19305") => [
  process.execPath,
  path.join(root, "dist", "index.js"),
  "gateway",
  "--port",
  port,
];
const portUsage = (port: number, busy: boolean) => ({
  port,
  status: busy ? ("busy" as const) : ("free" as const),
  listeners: busy ? [{ pid: 4242, command: "openclaw-gateway" }] : [],
  hints: [],
});
const stopForUpdate = (updateInstallKind: "package" | "git" = "package") =>
  maybeStopManagedServiceBeforeMutableUpdate({
    updateInstallKind,
    root,
    shouldRestart: true,
    jsonMode: true,
  });
const activate = (overrides: Partial<Parameters<typeof maybeRestartService>[0]>) =>
  maybeRestartService({
    shouldRestart: true,
    result: serviceUpdateResult(root, { after: { version: VERSION } }),
    opts: { json: true, run },
    refreshServiceEnv: false,
    gatewayPort: 19305,
    requireRunningServiceAfterRestart: true,
    timeoutMs: 1000,
    ...overrides,
  });
const expectStaleCleanup = () =>
  expect(mocks.terminateStale).toHaveBeenCalledWith(
    [4242],
    expect.objectContaining({ env: expect.any(Object), assertCurrent: expect.any(Function) }),
  );
const recoveryHealth = (
  port: number,
  running = false,
  staleGatewayPids: number[] = [],
  busy = running,
): Awaited<ReturnType<typeof mocks.health>> => ({
  outcome: running ? "ready" : "failed",
  healthy: running,
  staleGatewayPids,
  runtime: { status: running ? "running" : "stopped" },
  portUsage: { port, status: busy ? "busy" : "free", listeners: [], hints: [] },
});
// Retain worker imports, not snapshots or authority, across service observations.
const inspectionWorkers = createSqliteReadOnlyWorkerScope();
aroundEach((runTest) => inspectionWorkers.run(runTest));
afterAll(() => inspectionWorkers.close());

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.exit.mockReset();
  stubNodeRuntime();
  mockProcessPlatform("linux");
  ({ root, configPath, envSnapshot, servingOwner } = await createServiceActivationFixture());
  const runEnv = { ...process.env };
  run = { runId: createUpdateRun({ trigger: "cli" }, { env: runEnv }).runId, env: runEnv };
  mocks.ports.mockImplementation(async (port) =>
    portUsage(port, process.platform === "linux" && mocks.running),
  );
  mocks.call.mockReset();
  mocks.call.mockImplementation(
    gatewayHealthResponse({
      server: { version: VERSION, buildId: "target-build", bootId: "service-boot" },
    }),
  );
  mocks.running = true;
  mocks.loaded = true;
  mocks.managerUid = 2001;
  mocks.launchctl.mockImplementation(async () => {
    throw new Error("Unexpected native control in fixture");
  });
  mocks.events = [];
  mocks.stopAllowances = [];
  mocks.capability.mockResolvedValue({ kind: "sealed", reason: "foreign-owner" });
  mocks.command.mockResolvedValue({
    programArguments: gatewayArgs(),
    environment: { HOME: root },
    sourcePath: "/etc/systemd/system/openclaw-gateway.service",
  });
  mocks.child.mockReset().mockImplementation(async (args) => {
    expect(args).toContain("restart");
    mocks.events.push("fresh CLI restart");
    mocks.running = true;
    return commandResult({
      stdout: JSON.stringify({ action: "restart", ok: true, result: "restarted" }),
    });
  });
  mocks.health.mockImplementation(async ({ port }) => readyRecoveryHealth(port, mocks.running));
  mocks.configSnapshot
    .mockReset()
    .mockRejectedValue(new Error("Unexpected config snapshot during preserved activation"));
});
afterEach(async () => {
  await servingOwner.release();
  await closeOpenClawStateDatabaseAsync();
  envSnapshot.restore();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("preserved update activation with real version guards", () => {
  registerRestartOutcomeTests(() => ({ root, run, mocks, servingOwner }));

  it.each(preservedActivationCases)(
    "handles $phase $denial denial for $mode activation ($outcome; json=$json)",
    async ({ mode, denial, outcome, json }) => {
      const definitionRecovery: UpdateServiceDefinitionRecovery = {};
      let nowMs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => nowMs);
      vi.spyOn(runtimeUtils, "sleep").mockImplementation(async (ms) => {
        nowMs += ms;
      });
      mocks.command.mockResolvedValue({
        ...(await mocks.command(process.env)),
        programArguments: gatewayArgs(),
        environment: { HOME: root, MANAGED_VALUE: "revalidated" },
      });
      mocks.capability.mockResolvedValue({ kind: "writable" });
      const before = await stopForUpdate(mode === "git" ? "git" : "package");
      const repair = vi.spyOn(startRepair, "repairLoadedGatewayServiceForStart");
      mocks.child.mockImplementation(async (args) => {
        if (args.includes("install")) {
          mocks.capability.mockResolvedValue({
            kind: denial,
            reason: denial === "sealed" ? "foreign-owner" : "inspection-failed",
          });
          if (outcome === "uninspectable") {
            mocks.command.mockRejectedValue(new Error("manager inspection failed"));
          } else if (outcome === "foreign") {
            const command = await mocks.command(process.env);
            mocks.command.mockResolvedValue({
              ...command,
              programArguments: ["/foreign/openclaw", "gateway"],
            });
          }
          return commandResult({
            code: 1,
            stdout:
              outcome === "clean refusal"
                ? JSON.stringify({
                    ok: false,
                    error: `SERVICE_DEFINITION_${denial.toUpperCase()}: late owner denial`,
                  })
                : "",
            stderr:
              outcome === "clean refusal"
                ? ""
                : `SERVICE_DEFINITION_${denial.toUpperCase()}: late owner denial`,
          });
        }
        if (mocks.running) {
          await servingOwner.publish();
        }
        const program = new Command().exitOverride();
        addGatewayServiceCommands(program.command("gateway"));
        await program.parseAsync(args.slice(2), { from: "user" });
        return commandResult({
          stdout: JSON.stringify(mocks.writeJson.mock.lastCall?.[0]),
        });
      });
      const commandBefore = await mocks.command(process.env);
      mocks.ports.mockImplementation(async (port) => portUsage(port, true));
      mocks.call.mockImplementation(
        gatewayHealthResponse({
          server: {
            version: VERSION,
            connId: "fixture",
            bootId: "service-boot",
            ...(outcome === "missing build" ? {} : { buildId: "new-build" }),
          },
        }),
      );
      const { waitForGatewayHealthyRestart } = await vi.importActual<
        typeof import("../daemon-cli/restart-health.js")
      >("../daemon-cli/restart-health.js");
      let retried = false;
      mocks.health.mockImplementation(async (params) => {
        const stale = outcome === "stale retry" && params.expectedVersion === VERSION && !retried;
        retried ||= stale;
        if (stale) {
          return {
            ...recoveryHealth(params.port, true, [4242]),
            outcome: "failed",
            healthy: false,
          };
        }
        return await waitForGatewayHealthyRestart(params);
      });
      const activated = await activate({
        result: serviceUpdateResult(root, {
          mode,
          before: { version: "2026.1.1" },
          after: { version: VERSION, buildId: "new-build" },
        }),
        opts: { json, run },
        refreshServiceEnv: true,
        ...(outcome === "clean refusal" ? { definitionRecovery } : {}),
        serviceUpdateVerdict: before.serviceUpdateVerdict,
        serviceManagerUid: before.serviceManagerUid,
        serviceEnv: before.serviceEnv,
        gatewayPort: 19001,
      });
      const allowed = !["uninspectable", "foreign"].includes(outcome);
      const buildMismatch = outcome === "missing build";
      expect(activated).toBe(!allowed ? "failed" : buildMismatch ? "restart-health-failed" : "ok");
      if (outcome === "clean refusal") {
        expect(definitionRecovery).toEqual({ preserved: true, unverified: false });
        expect(mocks.running).toBe(true);
        expect(mocks.events).toContain("native restart");
      }
      const restarts = mocks.child.mock.calls.filter(([args]) => args.includes("restart"));
      if (!allowed) {
        expect(restarts).toHaveLength(0);
      }
      for (const [args, options] of restarts) {
        expect(args).toContain("--preserve-definition");
        expect(typeof options === "object" && options.env?.MANAGED_VALUE).toBe("revalidated");
        expect(args).toContain("--json");
      }
      if (retried) {
        expectStaleCleanup();
      }
      if (allowed) {
        expect(await mocks.command(process.env)).toEqual(commandBefore);
        expect(mocks.call).toHaveBeenCalled();
        expect(
          mocks.call.mock.calls.every(
            ([args]) => args.localPortOverride === 19305 && args.method === "health",
          ),
        ).toBe(true);
      }
      if (buildMismatch) {
        expect(
          mocks.error.mock.calls.flat().concat(mocks.log.mock.calls.flat()).join("\n"),
        ).toContain(
          "Gateway build mismatch: expected new-build, running gateway reported unavailable.",
        );
      }
      expectUncalled(mocks.start, repair, mocks.install, mocks.doctor);
    },
  );

  it("rejects a target without preservation support before automatic repair, with a JSON diagnostic", async () => {
    const before = await stopForUpdate();
    expect(before.stopped).toBe(true);
    // Permissions can change after the original preservation verdict.
    mocks.capability.mockResolvedValue({ kind: "writable" });
    const repair = vi
      .spyOn(startRepair, "repairLoadedGatewayServiceForStart")
      .mockRejectedValue(new Error("automatic repair reached"));
    mocks.child.mockImplementation(async (args) => {
      let stderr = "";
      const program = new Command().exitOverride().configureOutput({
        writeErr: (text) => {
          stderr += text;
        },
      });
      // Option parsing must reject before the normal restart action can run.
      program
        .command("gateway")
        .command("restart")
        .option("--json")
        .action(async (opts: { json?: boolean }) => {
          await runDaemonRestart(opts);
        });
      try {
        await program.parseAsync(args.slice(2), { from: "user" });
        return commandResult({ stderr });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("unknown option")) {
          throw error;
        }
        return commandResult({ code: 1, stderr });
      }
    });
    const activated = await activate({
      serviceUpdateVerdict: before.serviceUpdateVerdict,
      serviceManagerUid: before.serviceManagerUid,
      serviceEnv: before.serviceEnv,
    });
    expect(activated).toBe("failed");
    expect(mocks.error.mock.calls.flat().join("\n")).toContain("unknown option");
    expect(mocks.error.mock.calls.flat().join("\n")).toContain("stopped");
    expectUncalled(repair, mocks.restart, mocks.health);
  });

  registerRecoveryTests(() => ({ root, configPath, run, mocks }));

  registerGenerationRecoveryTests(() => ({ root, configPath, mocks }));

  registerInstallRootTransitionTests(() => ({ root, run, mocks }));
  registerPackageRootRollbackTests(() => ({ root, run, mocks }));

  it.each(["metadata", "profile", "unit"])(
    "pins writable service identity across %s changes",
    async (change) => {
      mocks.capability.mockResolvedValue({ kind: "writable" });
      const before = await stopForUpdate();
      const profile = change === "profile" ? "second" : "default";
      const stateDir = path.join(root, profile === "second" ? ".openclaw-second" : ".openclaw");
      const unit =
        change === "unit"
          ? "openclaw-gateway-custom.service"
          : profile === "second"
            ? "openclaw-gateway-second.service"
            : "openclaw-gateway.service";
      mocks.command.mockResolvedValue({
        ...(await mocks.command(process.env)),
        programArguments: gatewayArgs("19002"),
        environment: {
          HOME: root,
          OPENCLAW_GATEWAY_PORT: "19002",
          OPENCLAW_PROFILE: profile,
          OPENCLAW_SYSTEMD_UNIT: unit,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH:
            profile === "second" ? path.join(stateDir, "openclaw.json") : configPath,
        },
      });
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: before.serviceEnv,
        requireEffective: true,
        validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      });
      const revalidated = revalidateManagedGatewayServiceAfterUpdate({
        state,
        root,
        preManagedServiceStop: before,
      });
      if (change !== "metadata") {
        await expect(revalidated).rejects.toThrow("manager identity changed");
      } else {
        await expect(revalidated).resolves.toMatchObject({
          kind: "owned",
          refreshDefinition: true,
        });
      }
      expect(mocks.events).toEqual(["native stop"]);
    },
  );

  registerPluginMaintenanceTests(() => ({ root, run, mocks, writeConfig }));

  it.each(["missing", "uninspectable", "disappeared after inspection"])(
    "does not fall through to an unmanaged listener when the selected service is %s",
    async (scenario) => {
      if (scenario === "uninspectable") {
        mocks.command.mockRejectedValue(new Error("manager unavailable"));
        await expect(runDaemonRestart({ json: true, preserveDefinition: true })).rejects.toThrow(
          "manager unavailable",
        );
      } else if (scenario === "missing") {
        mocks.command.mockResolvedValue(null);
        await expect(runDaemonRestart({ json: true, preserveDefinition: true })).rejects.toThrow(
          "could not be inspected",
        );
      } else {
        const command = await mocks.command(process.env);
        mocks.command.mockResolvedValueOnce(command).mockResolvedValue(null);
        mocks.loaded = false;
        await expect(runDaemonRestart({ json: true, preserveDefinition: true })).resolves.toBe(
          false,
        );
      }
      expectUncalled(mocks.restart, mocks.install, mocks.listenerPids, mocks.signal, mocks.health);
    },
  );

  it("refuses preserved activation through safe process signaling", async () => {
    await expect(runDaemonRestart({ preserveDefinition: true, safe: true })).rejects.toThrow();
    expectUncalled(mocks.restart, mocks.listenerPids, mocks.signal);
  });

  // Native start/restart policy and handoff cases live in daemon/launchd*.test.ts.
  it.each(["recovery refusal", "late unknown"])(
    "preserves LaunchAgent artifacts during parent %s activation",
    async (scenario) => {
      mockProcessPlatform("darwin");
      const label = "ai.openclaw.gateway";
      const plistPath = resolveLaunchAgentPlistPath(process.env);
      const envPath = resolveLaunchAgentEnvironmentReadOptions(
        process.env,
        label,
      ).expectedEnvironmentFilePath;
      const wrapperPath = resolveLaunchAgentEnvWrapperPath(process.env, label);
      const plist = buildLaunchAgentPlist({
        label,
        programArguments: gatewayArgs(),
        stdoutPath: path.join(root, "gateway.log"),
        stderrPath: path.join(root, "gateway.err"),
        environment: {
          HOME: root,
          OPENCLAW_GATEWAY_TOKEN: "fixture-inline-token",
          OPENCLAW_SERVICE_VERSION: "legacy",
        },
      });
      for (const [file, content, mode] of [
        [plistPath, plist, 0o444],
        [envPath, "EXISTING=env\n", 0o600],
        [wrapperPath, "#!/bin/sh\n# existing wrapper\n", 0o700],
      ] as const) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, { mode });
      }
      const snapshot = async () =>
        Promise.all(
          [plistPath, envPath, wrapperPath, configPath].map(async (file) => ({
            file,
            bytes: await fs.readFile(file),
            mode: (await fs.stat(file)).mode,
          })),
        );
      const before = await snapshot();
      const writeFile = vi.spyOn(fs, "writeFile");
      const chmod = vi.spyOn(fs, "chmod");
      const rename = vi.spyOn(fs, "rename");
      mocks.launchctl.mockImplementation(async (args) => {
        if (args[0] === "bootstrap") {
          return { code: 13, stdout: "", stderr: "permission denied", termination: "exit" };
        }
        if (args[0] === "print" || args[0] === "kickstart") {
          return { code: 113, stdout: "", stderr: "Could not find service", termination: "exit" };
        }
        return { code: 0, stdout: "", stderr: "", termination: "exit" };
      });
      if (scenario === "recovery refusal") {
        mocks.configSnapshot.mockResolvedValueOnce(undefined);
      }
      const lateDenial = scenario === "late unknown";
      const verdict = lateDenial
        ? await revalidateManagedGatewayServiceAfterUpdate({
            state: await readGatewayServiceState(resolveGatewayService(), {
              requireEffective: true,
            }),
            root,
          })
        : { kind: "owned" as const, root, fingerprint: "fixture", refreshDefinition: true };
      if (lateDenial) {
        mocks.child.mockResolvedValueOnce(
          commandResult({
            code: 1,
            stderr: "SERVICE_DEFINITION_UNKNOWN: late denial",
          }),
        );
      }
      mocks.health.mockImplementation(async ({ port }) => recoveryHealth(port));
      const result = await activate({
        refreshServiceEnv: lateDenial,
        serviceUpdateVerdict: verdict,
        serviceEnv: process.env,
        gatewayPort: lateDenial ? 19001 : 19305,
      });
      expect(mocks.error.mock.calls.flat().join("\n")).toContain("did not become healthy");
      expect(mocks.health.mock.calls.every(([args]) => args.port === 19305)).toBe(true);
      expect(mocks.doctor).not.toHaveBeenCalled();
      expect(result).toBe(lateDenial ? "restart-health-failed" : "failed");
      if (!lateDenial) {
        // Writable recovery migrates legacy service metadata before native bootstrap.
        expect((await snapshot()).at(-1)).toEqual(before.at(-1));
        expect(writeFile).toHaveBeenCalled();
      } else {
        expect(await snapshot()).toEqual(before);
        expectUncalled(writeFile, chmod, rename);
      }
      expect(mocks.configSnapshot).toHaveBeenCalledTimes(lateDenial ? 0 : 1);
      if (!lateDenial) {
        expect(mocks.launchctl.mock.calls.some(([args]) => args[0] === "bootstrap")).toBe(true);
        expect(mocks.child).toHaveBeenCalledOnce();
      } else {
        expect(mocks.launchctl.mock.calls.every(([args]) => args[0] === "print")).toBe(true);
      }
    },
  );

  it("fresh restart still rejects config newer than its own binary", async () => {
    await writeConfig("9999.1.1");
    await expect(runDaemonRestart({ json: true, preserveDefinition: true })).resolves.toBe(false);
    expectUncalled(mocks.restart, mocks.install, mocks.health);
  });
});
