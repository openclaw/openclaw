import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyCliProfileEnv } from "../cli/profile.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { GatewayServiceAuthorityError } from "../daemon/service-update-authority.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { readLoadedSystemdServiceRuntime } from "../daemon/systemd-loaded-runtime.js";
import { writeDoctorGatewayConfig } from "../flows/doctor-health-contribution-runners.gateway.js";
import * as sqliteSnapshotSource from "../infra/sqlite-snapshot-source.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";
import { prepareWriterContext } from "./doctor-gateway-services.writer-order.test-support.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import {
  stoppedSystemdBinding,
  useDoctorMaintenanceRuntimeDirectory,
} from "./doctor-maintenance.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  gatewayPid: 4200,
  resident: vi.fn<() => { pid: number } | undefined>(),
  activeRoot: "",
  runtimeDirectory: "",
  runtimePath: "",
  installPlanBuilt: false,
  audit: vi.fn<typeof import("../daemon/service-audit.js").auditGatewayServiceConfig>(),
  confirm: vi.fn(),
  note: vi.fn(),
  health: vi.fn(async () => ({ healthy: true })),
  suspend: vi.fn<typeof import("../daemon/schtasks.js").suspendScheduledTaskAutoStartForUpdate>(),
  resume: vi.fn<typeof import("../daemon/schtasks.js").resumeScheduledTaskAutoStartAfterUpdate>(),
}));
vi.mock("../daemon/service-process-membership.js", () => ({
  // This in-memory service places Doctor outside its synthetic process scope.
  inspectServiceProcessMembershipSync: (pid: number) =>
    pid === mocks.gatewayPid ? "outside" : "unknown",
}));
vi.mock("../gateway/call.js", async (original) => {
  const { gatewayMaintenanceResponse } = await import("../gateway/health-response.test-support.js");
  return {
    ...(await original<typeof import("../gateway/call.js")>()),
    callGatewayCli: gatewayMaintenanceResponse(() => mocks.resident()),
  };
});

vi.mock("../daemon/systemd-exec.js", async (original) => {
  const { gatewayMaintenanceSystemdShow } =
    await import("../gateway/health-response.test-support.js");
  return {
    ...(await original<typeof import("../daemon/systemd-exec.js")>()),
    execSystemctlUser: gatewayMaintenanceSystemdShow,
  };
});

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: mocks.confirm,
}));
vi.mock("../daemon/schtasks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/schtasks.js")>()),
  suspendScheduledTaskAutoStartForUpdate: mocks.suspend,
  resumeScheduledTaskAutoStartAfterUpdate: mocks.resume,
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => mocks.service(),
}));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));
vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: async ({ port }: { port: number }) => {
    mocks.installPlanBuilt = true;
    return {
      programArguments: [
        mocks.runtimePath,
        path.join(mocks.activeRoot, "dist/index.js"),
        "gateway",
        "--port",
        String(port),
      ],
      environment: {
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin",
        OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE,
      },
    };
  },
}));
// Installation consent owns the launcher drift; runtime capability is a separate probe.
vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveNodeRuntimeInfo: async () => ({
    status: "supported" as const,
    version: "26.8.1",
    sqliteVersion: "3.53.4",
    sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    nodeSharedSqlite: false,
  }),
}));
vi.mock("../daemon/service-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service-audit.js")>()),
  auditGatewayServiceConfig: mocks.audit,
}));
vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.health,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let handoffBinding: ReturnType<typeof createManagedHandoffTestBinding>;
useDoctorMaintenanceRuntimeDirectory(() => {
  mocks.runtimeDirectory = realpathSync(tempDirs.make("openclaw-doctor-installation-runtime-"));
  handoffBinding = createManagedHandoffTestBinding(mocks.runtimeDirectory);
  vi.stubEnv(
    "NODE_OPTIONS",
    `${process.env.NODE_OPTIONS ?? ""} ${handoffBinding.nodeOption}`.trim(),
  );
  return mocks.runtimeDirectory;
});
const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
beforeEach(() => {
  handoffBinding.assertPath(resolveManagedUpdateLeaseDatabasePath());
  vi.clearAllMocks();
  mocks.resident.mockReset();
  mocks.audit.mockResolvedValue({ ok: true, issues: [] });
  mocks.installPlanBuilt = false;
  for (const native of [mocks.suspend, mocks.resume]) {
    native.mockImplementation(async (_env, options) => {
      options?.assertCurrent?.();
      await options?.beforeMutation?.();
      options?.assertCurrent?.();
      return true;
    });
  }
});
afterEach(() => {
  if (originalStdinIsTTY) {
    Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function runInstallationCase(params: {
  platform: "linux" | "darwin" | "win32";
  mode: "maintenance" | "direct";
  installFails?: boolean;
  tokenRecovery?: "success" | "refused" | "service-failure" | "writer-unavailable";
  revoked?: "unchanged" | "restored" | "recovery-pending" | "unclassified";
  initiallyStopped?: boolean;
  releaseStateBeforeFinish?: boolean;
  inspectionFailure?: "unavailable" | "lost-before-install";
  restorationInspectionFailure?: "read-error" | "unknown-runtime";
  inspectionScenario?: "slow-admission" | "competing-update";
  invocationPort?: string;
  profile?: string;
  updateInProgress?: boolean;
  consent?: {
    aggressive: boolean;
    approved: boolean;
    interactive: boolean;
    mixed?: "stale-native" | "custom-argv" | "version-managed-runtime";
  };
}) {
  const { installFails, initiallyStopped } = params;
  if (params.consent) {
    const { auditGatewayServiceConfig } = await vi.importActual<
      typeof import("../daemon/service-audit.js")
    >("../daemon/service-audit.js");
    mocks.audit.mockImplementation(async (options) => {
      const audit = await auditGatewayServiceConfig(options);
      if (params.consent?.mixed === "stale-native") {
        audit.definitionDrift = [
          ...(audit.definitionDrift ?? []),
          {
            kind: "outdated",
            key: "RunAtLoad",
            current: false,
            expected: true,
            message: "LaunchAgent RunAtLoad differs from the installer value true.",
          },
        ];
      }
      return audit;
    });
    mocks.confirm.mockResolvedValue(params.consent.approved);
    Object.defineProperty(process.stdin, "isTTY", {
      value: params.consent.interactive,
      configurable: true,
    });
  }
  mockProcessPlatform(params.platform);
  mockSystemAccountHome();
  const home = await fs.realpath(tempDirs.make("openclaw-doctor-installation-"));
  mocks.runtimePath =
    params.consent?.mixed === "version-managed-runtime"
      ? path.join(home, ".nvm", "versions", "node", "v26.8.1", "bin", "node")
      : path.join(home, "runtime", "node");
  const oldRoot = path.join(home, "prefix-a/lib/node_modules/openclaw");
  mocks.activeRoot = path.join(home, "prefix-b/lib/node_modules/openclaw");
  for (const [root, version] of [
    [oldRoot, "2026.9.4"],
    [mocks.activeRoot, "2026.9.17"],
  ] as const) {
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
    await fs.writeFile(path.join(root, "dist/index.js"), "export {};\n");
  }
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: params.profile,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
      OPENCLAW_SYSTEMD_UNIT: undefined,
      OPENCLAW_GATEWAY_PORT: params.invocationPort,
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: params.updateInProgress ? "1" : undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
    },
    async () => {
      if (params.profile) {
        applyCliProfileEnv({ profile: params.profile, homedir: () => home });
      }
      if (params.inspectionScenario) {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
      }
      let command: GatewayServiceCommandConfig = {
        programArguments: [
          mocks.runtimePath,
          path.join(oldRoot, "dist/index.js"),
          ...(params.consent?.aggressive ? ["node", "run"] : ["gateway"]),
          "--port",
          "19989",
          ...(params.consent?.mixed === "custom-argv" ? ["--verbose"] : []),
        ],
        environment: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          ...(params.tokenRecovery ? { OPENCLAW_GATEWAY_TOKEN: "maintenance-fixture-token" } : {}),
          ...(params.profile ? { OPENCLAW_PROFILE: params.profile } : {}),
        },
      };
      const originalCommand = structuredClone(command);
      let running = !initiallyStopped;
      const pid = mocks.gatewayPid;
      mocks.resident.mockImplementation(() => (running ? { pid } : undefined));
      let nativeInspectionReads = 0;
      let inspectionClock = 0;
      let inspectingRuntime = false;
      let competingUpdateStarted = false;
      const installationInspectionElapsedMs: number[] = [];
      const events: string[] = [];
      let writerContext: Awaited<ReturnType<typeof prepareWriterContext>> | undefined;
      let configPath: string | undefined;
      let originalConfig: string | undefined;
      const service = createMockGatewayService({
        isAbsent: async () => false,
        isLoaded: async () => true,
        readCommand: async () => {
          if (
            params.restorationInspectionFailure === "read-error" &&
            events.includes("repair-state")
          ) {
            throw new Error("Synthetic restoration command inspection failed");
          }
          return command;
        },
        readRuntime: async (env, opts) => {
          nativeInspectionReads += 1;
          if (
            params.inspectionFailure === "unavailable" ||
            (params.inspectionFailure === "lost-before-install" && nativeInspectionReads > 1) ||
            (params.restorationInspectionFailure === "unknown-runtime" &&
              events.includes("repair-state"))
          ) {
            return { status: "unknown" };
          }
          if (!running && params.inspectionScenario && opts?.loadForInspection) {
            const started = inspectionClock;
            const installationInspection = mocks.installPlanBuilt;
            inspectingRuntime = true;
            try {
              return await readLoadedSystemdServiceRuntime(
                env,
                opts.timeoutMs,
                opts.loadForInspection,
                stoppedSystemdBinding(() => {
                  if (
                    installationInspection &&
                    params.inspectionScenario === "competing-update" &&
                    !competingUpdateStarted
                  ) {
                    competingUpdateStarted = true;
                    createUpdateRun({
                      trigger: "cli",
                      origin: { driver: readUpdateRunDriver() },
                    });
                  }
                }),
              );
            } finally {
              inspectingRuntime = false;
              if (installationInspection) {
                installationInspectionElapsedMs.push(inspectionClock - started);
              }
            }
          }
          return {
            status: running ? "running" : "stopped",
            ...(running ? { pid } : {}),
            systemd: { managerUid: 2001 },
          };
        },
        stop: async () => {
          events.push("stop");
          running = false;
        },
        start: async () => {
          events.push("start");
          running = true;
        },
        install: async (plan) => {
          expect(getOpenClawDatabaseMaintenanceScope()).toBeUndefined();
          events.push("install");
          if (params.tokenRecovery) {
            expect(writerContext?.cfgForPersistence.gateway?.auth?.token).toBe(
              "maintenance-fixture-token",
            );
            expect(JSON.parse(await fs.readFile(configPath!, "utf8")).gateway.auth.token).toBe(
              "maintenance-fixture-token",
            );
          }
          if (params.revoked) {
            throw new GatewayServiceAuthorityError(
              new Error("Doctor custody was released"),
              params.revoked === "unclassified" ? undefined : params.revoked,
            );
          }
          if (installFails) {
            throw new Error("Synthetic native install rollback");
          }
          command = { programArguments: plan.programArguments, environment: { HOME: home } };
          running = true;
        },
        restart: async () => {
          events.push("restart");
          running = true;
          return { outcome: "completed" };
        },
      });
      mocks.service.mockReturnValue(service);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      if (params.mode === "direct") {
        await maybeRepairGatewayServiceConfig(
          { gateway: { auth: { mode: "token", token: "synthetic-doctor-token" } } },
          "local",
          runtime,
          createDoctorPrompter({
            runtime,
            options: { repair: true, nonInteractive: !params.consent?.interactive },
          }),
          {
            writeConfig: async () => {
              throw new Error("Installation-only repair must not request a config write.");
            },
          },
        );
        const notes = mocks.note.mock.calls.flat().join("\n");
        expect(notes).toContain(`${oldRoot} (2026.9.4)`);
        expect(notes).toContain(`${mocks.activeRoot} (2026.9.17)`);
        const cli = params.profile ? `openclaw --profile ${params.profile}` : "openclaw";
        expect(notes).toContain(`${cli} doctor --fix`);
        expect(notes).toContain(`${cli} gateway install --force`);
        if (params.updateInProgress) {
          expect(notes).toContain("deferred to update finalization");
          expect(events).toEqual([]);
          expect(command.programArguments[1]).toBe(path.join(oldRoot, "dist/index.js"));
          expect(mocks.confirm).not.toHaveBeenCalled();
          return;
        }
        if (params.consent) {
          expect(mocks.confirm).toHaveBeenCalledTimes(
            Number(
              Boolean(params.consent.aggressive || params.consent.mixed) &&
                params.consent.interactive,
            ),
          );
          if (params.consent.aggressive) {
            expect(notes).toContain("Service command does not include the gateway subcommand");
          }
        }
        if (
          params.inspectionFailure ||
          ((params.consent?.aggressive || params.consent?.mixed) && !params.consent.approved)
        ) {
          expect(events).toEqual([]);
          expect(command.programArguments[1]).toBe(path.join(oldRoot, "dist/index.js"));
        } else {
          expect(events).toEqual(
            params.platform === "win32" ? ["install", "restart"] : ["install"],
          );
          expect(command.programArguments[1]).toBe(path.join(mocks.activeRoot, "dist/index.js"));
          expect(command.programArguments).toContain(params.invocationPort ?? "19989");
          expect(notes).toContain("reconciled with the active CLI");
        }
        return;
      }
      if (params.tokenRecovery) {
        configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local", port: 19989 },
          plugins: { enabled: false },
        });
        originalConfig = await fs.readFile(configPath, "utf8");
        writerContext = await prepareWriterContext(configPath);
      }
      const maintenance = await beginDoctorMaintenance({
        root: mocks.activeRoot,
        options: { repair: true, nonInteractive: true },
        runtime,
      });
      if (params.inspectionScenario) {
        vi.spyOn(performance, "now").mockImplementation(() => inspectionClock);
        // Charge both fresh byte validation and fallback snapshots: reusing decoded
        // rows does not remove the fresh read at each native authority boundary.
        const readVersion = sqliteSnapshotSource.readSqliteSourceContentVersionSync;
        vi.spyOn(sqliteSnapshotSource, "readSqliteSourceContentVersionSync").mockImplementation(
          (pathname) => {
            const version = readVersion(pathname);
            if (inspectingRuntime) {
              inspectionClock += 100;
            }
            return version;
          },
        );
        const prepareSnapshot = sqliteSnapshotSource.prepareSqliteReadOnlyLocationSync;
        vi.spyOn(sqliteSnapshotSource, "prepareSqliteReadOnlyLocationSync").mockImplementation(
          (pathname) => {
            const prepared = prepareSnapshot(pathname);
            if (inspectingRuntime) {
              inspectionClock += 100;
            }
            return prepared;
          },
        );
      }
      try {
        expect(maintenance).toBeDefined();
        maintenance?.run(() => {
          expect(running).toBe(false);
          events.push("repair-state");
        });
        if (params.releaseStateBeforeFinish) {
          await maintenance?.releaseState();
        }
        let finishError: unknown;
        try {
          await maintenance?.finish(
            writerContext?.cfg ?? {
              gateway: { auth: { mode: "token", token: "synthetic-doctor-token" } },
            },
            writerContext && params.tokenRecovery !== "writer-unavailable"
              ? async (nextConfig) => {
                  events.push("write-config");
                  return writeDoctorGatewayConfig(
                    writerContext!,
                    params.tokenRecovery === "refused"
                      ? { ...nextConfig, gateway: { ...nextConfig.gateway, port: 0 } }
                      : nextConfig,
                  );
                }
              : undefined,
          );
        } catch (error) {
          finishError = error;
        }
        if (params.tokenRecovery) {
          expect(finishError).toBeUndefined();
          const bytes = await fs.readFile(configPath!, "utf8");
          const refused =
            params.tokenRecovery === "refused" || params.tokenRecovery === "writer-unavailable";
          expect(events).toEqual([
            "stop",
            "repair-state",
            ...(params.tokenRecovery === "writer-unavailable" ? [] : ["write-config"]),
            ...(refused ? [] : ["install"]),
          ]);
          if (refused) {
            expect(bytes).toBe(originalConfig);
            expect(writerContext?.cfg.gateway?.auth?.token).toBeUndefined();
            expect(running).toBe(false);
            expect(command).toEqual(originalCommand);
            expect(mocks.health).not.toHaveBeenCalled();
          } else {
            expect(JSON.parse(bytes).gateway.auth.token).toBe("maintenance-fixture-token");
            expect(writerContext?.cfgForPersistence).toEqual(writerContext?.cfg);
            expect(running).toBe(!installFails);
          }
          return;
        }
        if (params.inspectionScenario === "competing-update") {
          expect(competingUpdateStarted).toBe(true);
          expect(finishError).toMatchObject({
            message: expect.stringContaining("remains recorded as running"),
          });
          expect(events).toEqual(["stop", "repair-state"]);
          expect(running).toBe(false);
          expect(command.programArguments[1]).toBe(path.join(oldRoot, "dist/index.js"));
          expect(mocks.health).not.toHaveBeenCalled();
          return;
        }
        if (params.revoked) {
          const outcome = params.revoked === "unclassified" ? "recovery-pending" : params.revoked;
          const code = `service-authority-revoked-${outcome}`;
          expect(events).toEqual(["stop", "repair-state", "install"]);
          expect(running).toBe(false);
          expect(command.programArguments[1]).toBe(path.join(oldRoot, "dist/index.js"));
          expect(maintenance?.failureFacts).toEqual([
            expect.objectContaining({ check: "gateway-restoration", code }),
          ]);
          expect(maintenance?.warnings).toEqual([
            expect.stringContaining("openclaw gateway install --force --port 19989"),
          ]);
          expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(outcome));
          expect(mocks.health).not.toHaveBeenCalled();
          if (outcome === "recovery-pending") {
            expect(finishError).toMatchObject({
              failureFacts: [expect.objectContaining({ code })],
            });
          } else {
            expect(finishError).toBeUndefined();
          }
          return;
        }
        expect(finishError).toBeUndefined();
        if (params.restorationInspectionFailure) {
          expect(events).toEqual(["stop", "repair-state"]);
          expect(running).toBe(false);
          expect(command).toEqual(originalCommand);
          expect(maintenance?.warnings).toEqual([expect.stringContaining("could not reconcile")]);
          expect(maintenance?.warnings?.[0]).toContain("state compatibility is unverified");
          expect(runtime.log).toHaveBeenCalledWith(maintenance?.warnings?.[0]);
          expect(runtime.log).not.toHaveBeenCalledWith(
            "Gateway restarted and verified after Doctor repair.",
          );
          expect(mocks.health).not.toHaveBeenCalled();
          return;
        }
        if (params.inspectionScenario === "slow-admission") {
          expect(installationInspectionElapsedMs.length).toBeGreaterThan(0);
          for (const elapsed of installationInspectionElapsedMs) {
            expect(elapsed).toBeGreaterThan(0);
            expect(elapsed).toBeLessThan(5000);
          }
        }
        if (initiallyStopped) {
          expect(events).toEqual(["repair-state"]);
          expect(running).toBe(false);
          expect(command.programArguments[1]).toBe(path.join(oldRoot, "dist/index.js"));
          expect(maintenance?.warnings).toEqual([
            expect.stringContaining(
              "Stopped service definitions are preserved; run `openclaw gateway install --force --port 19989` from the active CLI.",
            ),
          ]);
          expect(maintenance?.warnings?.[0]).not.toContain("doctor --fix");
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining(`${oldRoot} (2026.9.4)`),
          );
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining(`${mocks.activeRoot} (2026.9.17)`),
          );
          expect(mocks.health).not.toHaveBeenCalled();
          return;
        }
        expect(events).toEqual(["stop", "repair-state", "install"]);
        expect(command.programArguments[1]).toBe(
          path.join(installFails ? oldRoot : mocks.activeRoot, "dist/index.js"),
        );
        expect(command.programArguments).toContain(params.invocationPort ?? "19989");
        expect(running).toBe(!installFails);
        expect(maintenance?.warnings).toEqual(
          installFails ? [expect.stringContaining("could not reconcile")] : [],
        );
        if (installFails) {
          expect(mocks.health).not.toHaveBeenCalled();
          expect(maintenance?.warnings).toEqual([
            expect.stringContaining("state compatibility is unverified"),
          ]);
        } else {
          expect(mocks.health).toHaveBeenCalledWith(expect.objectContaining({ port: 19989 }));
        }
        if (params.platform === "win32") {
          expect(mocks.suspend).toHaveBeenCalledOnce();
        }
      } finally {
        await maintenance?.release();
      }
      if (params.platform === "win32") {
        expect(mocks.resume).not.toHaveBeenCalled();
      }
    },
  );
}

it.each(["success", "refused", "service-failure", "writer-unavailable"] as const)(
  "delegates maintenance token recovery before native service mutation (%s)",
  async (tokenRecovery) =>
    runInstallationCase({
      platform: "linux",
      mode: "maintenance",
      tokenRecovery,
      installFails: tokenRecovery === "service-failure",
    }),
);

it.each(["success", "install-failed", "already-stopped"] as const)(
  "Doctor handles two-prefix drift through maintenance finish (%s)",
  async (scenario) =>
    runInstallationCase({
      platform: "linux",
      mode: "maintenance",
      installFails: scenario === "install-failed",
      initiallyStopped: scenario === "already-stopped",
    }),
);

it.each(["read-error", "unknown-runtime"] as const)(
  "keeps the old installation stopped after inconclusive restoration inspection (%s)",
  async (restorationInspectionFailure) =>
    runInstallationCase({
      platform: "linux",
      mode: "maintenance",
      restorationInspectionFailure,
    }),
);

it("reconciles installation drift within the native budget with slow admission snapshots", async () =>
  runInstallationCase({
    platform: "linux",
    mode: "maintenance",
    inspectionScenario: "slow-admission",
  }));

it("refuses installation repair when an update starts during passive native inspection", async () =>
  runInstallationCase({
    platform: "linux",
    mode: "maintenance",
    inspectionScenario: "competing-update",
  }));

it.each(["linux", "darwin", "win32"] as const)(
  "diagnoses and repairs a running service pinned to another package with doctor --fix on %s",
  async (platform) => runInstallationCase({ platform, mode: "direct" }),
);

it("honors an explicit invoking Gateway port while repairing installation drift", async () =>
  runInstallationCase({ platform: "linux", mode: "direct", invocationPort: "19990" }));

it.each([
  { aggressive: true, approved: false, interactive: true },
  { aggressive: true, approved: true, interactive: true },
  { aggressive: true, approved: false, interactive: false },
  { aggressive: false, approved: false, interactive: true },
  { aggressive: false, approved: false, interactive: true, mixed: "stale-native" },
  { aggressive: false, approved: true, interactive: true, mixed: "stale-native" },
  { aggressive: false, approved: false, interactive: false, mixed: "stale-native" },
  { aggressive: false, approved: false, interactive: true, mixed: "custom-argv" },
  { aggressive: false, approved: true, interactive: true, mixed: "custom-argv" },
  { aggressive: false, approved: false, interactive: false, mixed: "custom-argv" },
  { aggressive: false, approved: false, interactive: true, mixed: "version-managed-runtime" },
  { aggressive: false, approved: true, interactive: true, mixed: "version-managed-runtime" },
  { aggressive: false, approved: false, interactive: false, mixed: "version-managed-runtime" },
] as const)(
  "requires consent beyond installation drift (aggressive=$aggressive, mixed=$mixed, approved=$approved, interactive=$interactive)",
  async (consent) => runInstallationCase({ platform: "darwin", mode: "direct", consent }),
);

it.each([
  { installFails: false, releaseStateBeforeFinish: false },
  { installFails: true, releaseStateBeforeFinish: false },
  { installFails: false, releaseStateBeforeFinish: true },
  { installFails: true, releaseStateBeforeFinish: true },
])(
  "keeps Windows activation with the repaired installation (installFails=$installFails, releaseStateBeforeFinish=$releaseStateBeforeFinish)",
  async (scenario) => runInstallationCase({ platform: "win32", mode: "maintenance", ...scenario }),
);

it.each(["unavailable", "lost-before-install"] as const)(
  "leaves a stale service unchanged when native inspection is %s",
  async (inspectionFailure) =>
    runInstallationCase({ platform: "linux", mode: "direct", inspectionFailure }),
);

it.each(["unchanged", "restored", "recovery-pending", "unclassified"] as const)(
  "records native authority loss as a warning and blocks only pending recovery (%s)",
  (revoked) => runInstallationCase({ platform: "linux", mode: "maintenance", revoked }),
);

it("keeps installation reconciliation guidance on the selected profile", async () =>
  runInstallationCase({ platform: "linux", mode: "direct", profile: "work" }));

it.each(["linux", "darwin", "win32"] as const)(
  "leaves two-prefix installation drift with update finalization on %s",
  async (platform) => runInstallationCase({ platform, mode: "direct", updateInProgress: true }),
);
