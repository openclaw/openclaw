import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { readLoadedSystemdServiceRuntime } from "../daemon/systemd-loaded-runtime.js";
import * as sqliteSnapshotSource from "../infra/sqlite-snapshot-source.js";
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
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { stoppedSystemdBinding } from "./doctor-maintenance.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  activeRoot: "",
  runtimeDirectory: "",
  installPlanBuilt: false,
  note: vi.fn(),
  health: vi.fn(async () => ({ healthy: true })),
  suspend: vi.fn<typeof import("../daemon/schtasks.js").suspendScheduledTaskAutoStartForUpdate>(),
  resume: vi.fn<typeof import("../daemon/schtasks.js").resumeScheduledTaskAutoStartAfterUpdate>(),
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
        process.execPath,
        path.join(mocks.activeRoot, "dist/index.js"),
        "gateway",
        "--port",
        String(port),
      ],
      environment: { HOME: process.env.HOME },
    };
  },
}));
vi.mock("../daemon/service-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service-audit.js")>()),
  auditGatewayServiceConfig: async () => ({ ok: true, issues: [] }),
}));
vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.health,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../infra/state-database-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/state-database-coordinator.js")>();
  return {
    ...actual,
    acquireGatewayLifecycleCoordinator: (
      params: Parameters<typeof actual.acquireGatewayLifecycleCoordinator>[0],
    ) =>
      actual.acquireGatewayLifecycleCoordinator({
        ...params,
        runtimeDirectory: mocks.runtimeDirectory,
      }),
    acquireGatewayMaintenanceCoordinator: (
      params: Parameters<typeof actual.acquireGatewayMaintenanceCoordinator>[0],
    ) =>
      actual.acquireGatewayMaintenanceCoordinator({
        ...params,
        runtimeDirectory: mocks.runtimeDirectory,
      }),
    acquireStateDatabaseCoordinator: (
      params: Parameters<typeof actual.acquireStateDatabaseCoordinator>[0],
    ) =>
      actual.acquireStateDatabaseCoordinator({
        ...params,
        runtimeDirectory: mocks.runtimeDirectory,
      }),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.clearAllMocks();
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
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function runInstallationCase(params: {
  platform: "linux" | "darwin" | "win32";
  mode: "maintenance" | "direct";
  installFails?: boolean;
  initiallyStopped?: boolean;
  releaseStateBeforeFinish?: boolean;
  inspectionFailure?: "unavailable" | "lost-before-install";
  inspectionScenario?: "slow-admission" | "competing-update";
  invocationPort?: string;
}) {
  const { installFails, initiallyStopped } = params;
  mockProcessPlatform(params.platform);
  mockSystemAccountHome();
  const home = await fs.realpath(tempDirs.make("openclaw-doctor-installation-"));
  mocks.runtimeDirectory = home;
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
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
    },
    async () => {
      if (params.inspectionScenario) {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
      }
      let command: GatewayServiceCommandConfig = {
        programArguments: [
          process.execPath,
          path.join(oldRoot, "dist/index.js"),
          "gateway",
          "--port",
          "19989",
        ],
        environment: { HOME: home },
      };
      let running = !initiallyStopped;
      let nativeInspectionReads = 0;
      let inspectionClock = 0;
      let inspectingRuntime = false;
      let competingUpdateStarted = false;
      const installationInspectionElapsedMs: number[] = [];
      const events: string[] = [];
      const service = createMockGatewayService({
        isAbsent: async () => false,
        isLoaded: async () => true,
        readCommand: async () => command,
        readRuntime: async (env, opts) => {
          nativeInspectionReads += 1;
          if (
            params.inspectionFailure === "unavailable" ||
            (params.inspectionFailure === "lost-before-install" && nativeInspectionReads > 1)
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
          return { status: running ? "running" : "stopped", systemd: { managerUid: 2001 } };
        },
        stop: async () => {
          events.push("stop");
          running = false;
        },
        install: async (plan) => {
          expect(getOpenClawDatabaseMaintenanceScope()).toBeUndefined();
          events.push("install");
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
          createDoctorPrompter({ runtime, options: { repair: true, nonInteractive: true } }),
        );
        const notes = mocks.note.mock.calls.flat().join("\n");
        expect(notes).toContain(`${oldRoot} (2026.9.4)`);
        expect(notes).toContain(`${mocks.activeRoot} (2026.9.17)`);
        expect(notes).toContain("openclaw doctor --fix");
        expect(notes).toContain("openclaw gateway install --force");
        if (params.inspectionFailure) {
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
      const maintenance = await beginDoctorMaintenance({
        root: mocks.activeRoot,
        options: { repair: true, nonInteractive: true },
        runtime,
      });
      if (params.inspectionScenario) {
        vi.spyOn(performance, "now").mockImplementation(() => inspectionClock);
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
          await maintenance?.finish({
            gateway: { auth: { mode: "token", token: "synthetic-doctor-token" } },
          });
        } catch (error) {
          finishError = error;
        }
        if (params.inspectionScenario === "competing-update") {
          expect(competingUpdateStarted).toBe(true);
          expect(finishError).toMatchObject({
            message: expect.stringContaining("is still in progress"),
          });
          expect(events).toEqual(["stop", "repair-state"]);
          expect(running).toBe(false);
          expect(command.programArguments[1]).toBe(path.join(oldRoot, "dist/index.js"));
          expect(mocks.health).not.toHaveBeenCalled();
          return;
        }
        expect(finishError).toBeUndefined();
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
          expect(maintenance?.warnings).toEqual([expect.stringContaining("already stopped")]);
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
