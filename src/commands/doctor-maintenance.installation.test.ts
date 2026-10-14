import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { GatewayServiceAuthorityError } from "../daemon/service-update-authority.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { readLoadedSystemdServiceRuntime } from "../daemon/systemd-loaded-runtime.js";
import { writeDoctorGatewayConfig } from "../flows/doctor-health-contribution-runners.gateway.js";
import { callGatewayCli } from "../gateway/call.js";
import { storeDeviceAuthToken } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { tryAcquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as processAncestry from "../infra/restart-stale-pids.js";
import * as sqliteSnapshotSource from "../infra/sqlite-snapshot-source.js";
import * as sqliteWorkerStores from "../infra/sqlite-worker-store.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { readSecretStoreValue } from "../secrets/store/secret-store.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";
import { prepareWriterContext } from "./doctor-gateway-services.writer-order.test-support.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { mockDoctorServicePlatform } from "./doctor-maintenance.state-owner.test-support.js";
import {
  stoppedSystemdBinding,
  useDoctorMaintenanceRuntimeDirectory,
} from "./doctor-maintenance.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  gatewayPid: Math.max(process.pid, process.ppid, 1) + 1,
  resident: vi.fn<() => { pid: number } | undefined>(),
  activeRoot: "",
  runtimePath: "",
  installPlanBuilt: false,
  audit: vi.fn<typeof import("../daemon/service-audit.js").auditGatewayServiceConfig>(),
  confirm: vi.fn(),
  note: vi.fn(),
  health: vi.fn(async () => ({ outcome: "ready", healthy: true })),
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
    callGatewayCli: vi.fn(gatewayMaintenanceResponse(() => mocks.resident())),
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
  const runtimeDirectory = realpathSync(tempDirs.make("openclaw-doctor-installation-runtime-"));
  handoffBinding = createManagedHandoffTestBinding(runtimeDirectory);
  vi.stubEnv(
    "NODE_OPTIONS",
    `${process.env.NODE_OPTIONS ?? ""} ${handoffBinding.nodeOption}`.trim(),
  );
  return runtimeDirectory;
});
const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
beforeEach(() => {
  handoffBinding.assertPath(resolveManagedUpdateLeaseDatabasePath());
  vi.clearAllMocks();
  // Synthetic service platforms cannot inspect the host's native process ancestry.
  vi.spyOn(processAncestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
    pids: new Set([process.pid, process.ppid, 1]),
    complete: true,
  });
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
  bun?: boolean;
  installFails?: boolean;
  stopFailsWithPairedDevice?: boolean;
  tokenRecovery?: "success" | "writer-unavailable" | "no-consent";
  revoked?: "unchanged" | "restored" | "unclassified";
  initiallyStopped?: boolean;
  releaseStateBeforeFinish?: boolean;
  inspectionFailure?: "lost-before-install";
  restorationInspectionFailure?: "unknown-runtime";
  inspectionScenario?: "slow-admission" | "competing-update";
  invocationPort?: string;
  updateInProgress?: boolean;
  consent?: {
    aggressive: boolean;
    approved: boolean;
    interactive: boolean;
    mixed?: "custom-argv" | "version-managed-runtime";
  };
}) {
  const { installFails, initiallyStopped } = params;
  if (params.consent) {
    const { auditGatewayServiceConfig } = await vi.importActual<
      typeof import("../daemon/service-audit.js")
    >("../daemon/service-audit.js");
    mocks.audit.mockImplementation(auditGatewayServiceConfig);
    mocks.confirm.mockResolvedValue(params.consent.approved);
    Object.defineProperty(process.stdin, "isTTY", {
      value: params.consent.interactive,
      configurable: true,
    });
  }
  mockDoctorServicePlatform(params.platform);
  if (params.tokenRecovery) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: params.tokenRecovery !== "no-consent",
      configurable: true,
    });
    mocks.confirm.mockResolvedValue(true);
  }
  mockSystemAccountHome();
  const home = await fs.realpath(tempDirs.make("openclaw-doctor-installation-"));
  mocks.runtimePath =
    params.consent?.mixed === "version-managed-runtime"
      ? path.join(home, ".nvm", "versions", "node", "v26.8.1", "bin", "node")
      : path.join(home, "runtime", params.bun ? "bun" : "node");
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
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
      OPENCLAW_SYSTEMD_UNIT: undefined,
      OPENCLAW_GATEWAY_PORT: params.invocationPort,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: params.updateInProgress ? "1" : undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
    },
    async () => {
      const sourcePath =
        params.platform === "win32" ? resolveGatewayTaskScriptPath(process.env) : undefined;
      if (params.inspectionScenario) {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
      }
      let command: GatewayServiceCommandConfig = {
        ...(sourcePath ? { sourcePath } : {}),
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
        readCommand: async () => command,
        readRuntime: async (env, opts) => {
          nativeInspectionReads += 1;
          if (
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
          if (params.stopFailsWithPairedDevice) {
            throw new Error("Synthetic native stop failure");
          }
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
            const ref = JSON.parse(await fs.readFile(configPath!, "utf8")).gateway.auth.token;
            expect(ref).toMatchObject({ source: "store" });
            expect(writerContext?.cfgForPersistence.gateway?.auth?.token).toEqual(ref);
            const stored = await readSecretStoreValue({ scope: { kind: "team" }, name: ref.id });
            expect(stored.ok && stored.value === "maintenance-fixture-token").toBe(true);
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
          command = {
            ...(sourcePath ? { sourcePath } : {}),
            programArguments: plan.programArguments,
            environment: { HOME: home },
          };
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
        expect(notes).toContain("openclaw doctor --fix");
        expect(notes).toContain("openclaw gateway install --force");
        if (params.bun) {
          expect(events).toEqual([]);
          expect(running).toBe(true);
          expect(command).toEqual(originalCommand);
          expect(notes).toContain("automatic installation repair was skipped");
          return;
        }
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
      let pairedDeviceDatabasePath: string | undefined;
      if (params.stopFailsWithPairedDevice) {
        const identity = loadOrCreateDeviceIdentity();
        pairedDeviceDatabasePath = openOpenClawStateDatabase().path;
        await storeDeviceAuthToken({
          deviceId: identity.deviceId,
          role: "operator",
          token: "synthetic-maintenance-device-token",
          scopes: ["operator.admin"],
        });
        await closeOpenClawStateDatabaseAsync();
      }
      const authWorkerOpen = pairedDeviceDatabasePath
        ? vi.spyOn(sqliteWorkerStores, "openSharedStateSqliteWorkerStore")
        : undefined;
      const admission = beginDoctorMaintenance({
        root: mocks.activeRoot,
        options: {
          repair: true,
          nonInteractive: !params.tokenRecovery || params.tokenRecovery === "no-consent",
        },
        runtime,
      });
      if (pairedDeviceDatabasePath && authWorkerOpen) {
        const openedAuthWorkers = () =>
          authWorkerOpen.mock.settledResults.flatMap((result) =>
            result.type === "fulfilled" && result.value ? [result.value] : [],
          );
        try {
          await expect(admission).rejects.toThrow("Synthetic native stop failure");
          expect(events).toEqual(["stop"]);
          expect(running).toBe(true);
          expect(
            vi
              .mocked(callGatewayCli)
              .mock.calls.some(
                ([request]) =>
                  request.method === "status" &&
                  request.preparedDeviceAuth?.token === "synthetic-maintenance-device-token",
              ),
          ).toBe(true);
          const authWorkers = openedAuthWorkers();
          expect(authWorkers.length).toBeGreaterThan(0);
          expect(
            authWorkers.every((worker) => !sqliteWorkerStores.isSqliteWorkerStoreAvailable(worker)),
          ).toBe(true);
          const nextOwner = tryAcquireGatewayStateOwner(pairedDeviceDatabasePath);
          expect(nextOwner).not.toBeNull();
          nextOwner?.release();
        } finally {
          try {
            await Promise.all(openedAuthWorkers().map((worker) => worker.close()));
          } finally {
            await closeOpenClawStateDatabaseAsync();
          }
        }
        return;
      }
      const maintenance = await admission;
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
                  return writeDoctorGatewayConfig(writerContext!, nextConfig);
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
            params.tokenRecovery === "writer-unavailable" || params.tokenRecovery === "no-consent";
          expect(events).toEqual([
            "stop",
            "repair-state",
            ...(params.tokenRecovery === "writer-unavailable" ||
            params.tokenRecovery === "no-consent"
              ? []
              : ["write-config"]),
            ...(refused ? [] : ["install"]),
          ]);
          if (refused) {
            expect(bytes).toBe(originalConfig);
            expect(writerContext?.cfg.gateway?.auth?.token).toBeUndefined();
            expect(running).toBe(false);
            expect(command).toEqual(originalCommand);
            expect(mocks.health).not.toHaveBeenCalled();
            if (params.tokenRecovery === "no-consent") {
              expect(
                mocks.note.mock.calls.map(([message]) => String(message)).join("\n"),
              ).toContain("Skipped Gateway token preservation and service repair");
            }
          } else {
            expect(JSON.parse(bytes).gateway.auth.token).toMatchObject({ source: "store" });
            expect(writerContext?.cfgForPersistence).toEqual(writerContext?.cfg);
            expect(running).toBe(!installFails);
          }
          expect(bytes.includes("maintenance-fixture-token")).toBe(false);
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

type InstallationCase = Omit<Parameters<typeof runInstallationCase>[0], "mode">;

it.each<InstallationCase>([
  { platform: "linux", tokenRecovery: "success", installFails: false },
  { platform: "linux", tokenRecovery: "writer-unavailable", installFails: false },
  { platform: "linux", tokenRecovery: "no-consent", installFails: false },
  { platform: "linux", initiallyStopped: true },
  { platform: "linux", restorationInspectionFailure: "unknown-runtime" },
  { platform: "linux", inspectionScenario: "slow-admission" },
  { platform: "linux", stopFailsWithPairedDevice: true },
  { platform: "linux", inspectionScenario: "competing-update" },
  { platform: "win32", installFails: true, releaseStateBeforeFinish: true },
  { platform: "linux", revoked: "unchanged" },
  { platform: "linux", revoked: "restored" },
  { platform: "linux", revoked: "unclassified" },
])("reconciles installation drift under maintenance authority (%j)", async (scenario) =>
  runInstallationCase({ ...scenario, mode: "maintenance" }),
);

it.each<InstallationCase>([
  { platform: "win32" },
  { platform: "linux", invocationPort: "19990" },
  { platform: "darwin", consent: { aggressive: true, approved: true, interactive: true } },
  { platform: "darwin", consent: { aggressive: true, approved: false, interactive: false } },
  {
    platform: "darwin",
    consent: { aggressive: false, approved: false, interactive: true, mixed: "custom-argv" },
  },
  {
    platform: "darwin",
    consent: {
      aggressive: false,
      approved: false,
      interactive: true,
      mixed: "version-managed-runtime",
    },
  },
  { platform: "linux", inspectionFailure: "lost-before-install" },
  { platform: "linux", updateInProgress: true },
  { platform: "linux", bun: true },
])("repairs installation drift with doctor --fix (%j)", async (scenario) =>
  runInstallationCase({ ...scenario, mode: "direct" }),
);
