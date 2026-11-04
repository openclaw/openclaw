import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDoctorMaintenanceFixture } from "../../commands/doctor-maintenance.test-support.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import * as updateCheck from "../../infra/update-check.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { VERSION } from "../../version.js";
import {
  expectNoCalls,
  expectPartialCall,
} from "../daemon-cli/lifecycle-assertions.test-support.js";
import { cleanupUpdateCommandTest } from "./update-command-cleanup.test-support.js";
import {
  registerPrivateHandoffBindingTests,
  validConfigSnapshot,
  expectLifecycleBoundary,
  finalizationCleanupCases,
  prepareFinalizationPackage,
  successfulPluginUpdate,
} from "./update-command-lifecycle.test-support.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import * as gatewayVerification from "./update-command-verification.js";

const mocks = vi.hoisted(() => ({
  verifyGateway: vi.fn<typeof import("./update-command-verification.js").verifyUpdatedGateway>(),
  events: [] as string[],
  leaseActive: false,
  databasePath: "",
  readConfig: vi.fn(),
  doctorWarnings: [] as string[],
  triage: vi.fn(),
  maintenance:
    vi.fn<typeof import("../../commands/doctor-maintenance.js").beginDoctorMaintenance>(),
  interactive: false,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

function record(name: string): void {
  mocks.events.push(`${name}:${mocks.leaseActive}`);
}

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
  readConfigFileSnapshot: mocks.readConfig,
}));

vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: vi.fn(async () => mocks.triage),
}));
vi.mock("./update-command-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-verification.js")>()),
  verifyUpdatedGateway: mocks.verifyGateway,
}));
vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: vi.fn(async () => 19101),
}));

vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: mocks.maintenance,
}));

vi.mock("../terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal-interactivity.js")>()),
  isTerminalInteractive: () => mocks.interactive,
}));

vi.mock("../../commands/configure.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/configure.shared.js")>()),
  select: vi.fn(async () => "report"),
  confirm: vi.fn(async () => false),
}));

vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => {
    record("installed-records");
    return {};
  }),
}));

// mock-isolation: This lifecycle fixture has no persisted plugin index to read or mutate.
vi.mock("../../plugins/installed-plugin-index-store.js", () => ({
  readPersistedInstalledPluginIndex: vi.fn(async () => null),
}));

// mock-isolation: Lease custody is modeled by leaseActive, not the host's plugin lock.
vi.mock("../../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_params: unknown, run: () => Promise<unknown>) => {
    mocks.leaseActive = true;
    try {
      return await run();
    } finally {
      mocks.leaseActive = false;
    }
  },
}));

vi.mock("../../state/openclaw-state-ownership-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-ownership-preflight.js")>()),
  assertOpenClawStateWriteAllowedAtPath: vi.fn(async () => undefined),
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  readPackageVersion: vi.fn(async () => "2026.8.27"),
  resolveUpdateRoot: vi.fn(async () => "/tmp/openclaw"),
  tryWriteCompletionCache: vi.fn(async () => "completed"),
}));

// mock-isolation: The lifecycle fixture supplies config and must not snapshot host state.
vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: vi.fn(async () => undefined),
}));

vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  persistRequestedUpdateChannel: vi.fn(
    async (params: { configSnapshot: unknown }) => params.configSnapshot,
  ),
  readPostCorePreUpdateSourceConfig: vi.fn(async () => ({
    sourceConfig: {},
    authoredConfig: {},
  })),
  preparePostCorePluginConfig: vi.fn(async () => {
    const configSnapshot = await mocks.readConfig();
    record("prepare-config");
    return {
      configSnapshot,
      configWriteOptions: {},
      configChanged: false,
      restoredAuthoredChannels: [],
    };
  }),
}));

// mock-isolation: Exercise finalizer ordering without launching a real Doctor subprocess.
vi.mock("./update-command-fresh-doctor.js", () => ({
  completePostCorePluginUpdate: vi.fn(async () => ({
    pluginUpdate: successfulPluginUpdate,
    configSnapshot: validConfigSnapshot,
  })),
  runUpdateFinalizationDoctorInFreshProcess: vi.fn(
    async (params: { onWarnings?: (warnings: string[]) => void }) => {
      params.onWarnings?.(mocks.doctorWarnings);
    },
  ),
  withPrePluginUpdateDoctorEnv: async (run: () => Promise<unknown>) => await run(),
}));

vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: vi.fn(async () => {
    record("plugin-update");
    return successfulPluginUpdate;
  }),
}));

// Process fixtures cover runtime generation with real lifecycle ownership.
vi.mock("./update-command-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-runtime.js")>()),
  completeSourceUpdateRuntime: vi.fn(async () => ({ changed: false })),
}));

vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: vi.fn(),
  readPostCorePluginInstallRecordsFile: vi.fn(async () => {
    record("handoff-records");
    return {};
  }),
  writePostCorePluginUpdateResultFile: vi.fn(async () => undefined),
  writePostCoreUpdateFailureFile: vi.fn(async () => undefined),
}));

import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import { readPackageVersion, resolveUpdateRoot, tryWriteCompletionCache } from "./shared.js";
import { registerConvergenceCompletionTests } from "./update-command-convergence-completion.test-support.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  writePostCorePluginUpdateResultFile,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";

function finalize(
  options: Parameters<typeof updateFinalizeCommand>[0] = {},
  runIds?: Parameters<typeof updateFinalizeCommand>[1],
) {
  return updateFinalizeCommand({ json: true, yes: true, ...options }, runIds);
}

function convergeCurrent(overrides: Partial<Parameters<typeof convergeUpdatePlugins>[0]> = {}) {
  return convergeUpdatePlugins({
    coreAlreadyCurrent: true,
    result: resultFixture(undefined, {
      status: "skipped",
      reason: "already-current",
      durationMs: 1,
    }),
    root: "/fixture/openclaw",
    installKindChanged: false,
    configSnapshot: validConfigSnapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: "stable",
    downgradeRisk: false,
    opts: {},
    preUpdatePluginInstallRecords: {},
    startedAt: 1,
    updateStepTimeoutMs: 1_000,
    ...overrides,
  });
}

/** Keep physical cleanup pending while inspecting the command's publication boundary. */
function createRetainedCleanupFixture() {
  const physical = createDeferredCore<"forced" | "uncertain">();
  const joining = createDeferredCore();
  return {
    retain() {
      retainCommandProcessCleanup(physical.promise);
      const signal = resolveCommandProcessSignal();
      if (!signal) {
        throw new Error("Finalization lost its command scope");
      }
      signal.addEventListener("abort", () => joining.resolve(), { once: true });
    },
    async settle(work: Promise<unknown>, cleanup: "forced" | "uncertain", pending: () => void) {
      let finished = false;
      const observe = (error: unknown) => {
        finished = true;
        return error;
      };
      const command = work.then(() => observe(undefined), observe);
      try {
        await Promise.race([
          joining.promise,
          command.then(() => {
            throw new Error("Finalization returned before physical settlement");
          }),
        ]);
        expect(finished).toBe(false);
        pending();
      } finally {
        physical.resolve(cleanup);
        await command;
      }
      return await command;
    },
  };
}
describe("update plugin lifecycle lease boundaries", () => {
  afterEach(cleanupUpdateCommandTest);

  beforeEach(async () => {
    // Ordering-only fixtures own an absent private state root; never probe a
    // shared host path while real recovery admission is running.
    mocks.databasePath = path.join(dirs.make("update-lease-order-"), "state", "openclaw.sqlite");
    vi.clearAllMocks();
    vi.mocked(updatePluginsAfterCoreUpdate).mockReset();
    vi.mocked(completePostCorePluginUpdate).mockReset();
    vi.mocked(continuePostCoreUpdateInFreshProcess).mockReset();
    mocks.verifyGateway.mockReset().mockResolvedValue({ ok: false, summary: "stopped-free" });
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(mocks.databasePath)));
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
    mocks.events = [];
    mocks.leaseActive = false;
    mocks.doctorWarnings = [];
    mocks.interactive = false;
    mocks.triage.mockReset().mockResolvedValue({ status: "completed", hint: "fixture" });
    mocks.maintenance.mockReset().mockResolvedValue(undefined);
    vi.mocked(writePostCorePluginUpdateResultFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(writePostCoreUpdateFailureFile).mockReset().mockResolvedValue(undefined);
    const root = dirs.make("update-lease-package-");
    await writeFixtureJson(path.join(root, "package.json"), { name: "openclaw" });
    vi.mocked(resolveUpdateRoot).mockResolvedValue(root);
    vi.mocked(readPackageVersion).mockResolvedValue(VERSION);
    vi.mocked(continuePostCoreUpdateInFreshProcess).mockImplementation(async () => {
      record("target-convergence");
      return { resumed: true, pluginUpdate: { ...successfulPluginUpdate, changed: false } };
    });
    mocks.readConfig.mockImplementation(async () => {
      record("read-config");
      return validConfigSnapshot;
    });
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  });

  registerPrivateHandoffBindingTests();

  it.each(["returned", "plugins", "targetConfigConvergence"] as const)(
    "settles finalizer recovery before reporting a %s failure",
    async (phase) => {
      await prepareFinalizationPackage(await resolveUpdateRoot());
      mocks.verifyGateway.mockResolvedValue({ ok: true, summary: "healthy" });
      const returned = phase === "returned";
      const failure = new Error(`finalize:${phase} failed`);
      if (returned) {
        vi.mocked(completePostCorePluginUpdate).mockResolvedValueOnce({
          configSnapshot: validConfigSnapshot,
          pluginUpdate: { ...successfulPluginUpdate, status: "error" },
        });
      } else if (phase === "plugins") {
        vi.mocked(updatePluginsAfterCoreUpdate).mockRejectedValueOnce(failure);
      } else {
        vi.mocked(completePostCorePluginUpdate).mockRejectedValueOnce(failure);
      }
      const command = finalize({ timeout: returned ? undefined : "5" });
      const recovery = { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" };
      if (returned) {
        await expect(command).rejects.toMatchObject({ code: 1 });
        expectPartialCall(defaultRuntime.writeJson, { status: "error", recovery });
      } else {
        await expect(command).rejects.toBe(failure);
      }
      expect(mocks.verifyGateway).toHaveBeenCalledOnce();
      expect(listUpdateRuns()[0]).toMatchObject({ status: "failed", verification: { recovery } });
      expect(mocks.triage).toHaveBeenCalledOnce();
    },
  );

  it.each(["read", "write", "write-provisional", "read-write"] as const)(
    "preserves the phase failure when recovery history cannot %s",
    async (operation) => {
      await prepareFinalizationPackage(await resolveUpdateRoot());
      mocks.verifyGateway.mockResolvedValue({ ok: true, summary: "healthy" });
      const failure =
        operation === "write-provisional"
          ? new UpdateCommandFailure({
              status: "error",
              mode: "npm",
              reason: "plugin finalization failed",
              steps: [],
              durationMs: 0,
              recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            })
          : new Error("plugin finalization failed");
      let failedPhase = false;
      vi.mocked(updatePluginsAfterCoreUpdate).mockImplementationOnce(async () => {
        failedPhase = true;
        if (operation !== "read") {
          updateLedger.recordUpdateRunVerification(listUpdateRuns()[0]!.runId, {
            recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
          });
        }
        throw failure;
      });
      const unavailable = new Error("recovery database unavailable");
      if (operation === "read" || operation === "read-write") {
        const read = updateLedger.getUpdateRun;
        vi.spyOn(updateLedger, "getUpdateRun").mockImplementation((...args) => {
          if (failedPhase) {
            failedPhase = false;
            throw unavailable;
          }
          return read(...args);
        });
      }
      if (operation !== "read") {
        vi.spyOn(updateLedger, "recordUpdateRunDiagnostics").mockImplementationOnce(
          (_runId, _diagnostics, warn) => {
            warn(unavailable.message);
          },
        );
      }
      const finalization = finalize();
      if (operation === "write-provisional") {
        await expect(finalization).rejects.toMatchObject({ code: 1 });
      } else {
        await expect(finalization).rejects.toBe(failure);
      }
      expect(listUpdateRuns()[0]?.status).toBe("failed");
      if (operation !== "read") {
        expect(mocks.triage.mock.calls.at(-1)?.[0]).toMatchObject({
          failure: {
            result: {
              recovery:
                operation === "read-write"
                  ? undefined
                  : { serviceRestartSafe: false, reason: "state-migration-started" },
            },
          },
        });
      }
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining(unavailable.message),
      );
    },
  );

  it.each([false, true])(
    "reports the admitted Doctor failure (interactive=%s)",
    async (interactive) => {
      mocks.interactive = interactive;
      vi.mocked(readPackageVersion).mockResolvedValue("2026.9.4");
      await writeFixtureJson(path.join(await resolveUpdateRoot(), "package.json"), {
        name: "openclaw",
        version: "2026.9.4",
      });
      const maintenance = createDoctorMaintenanceFixture();
      mocks.maintenance.mockResolvedValueOnce(maintenance);
      const verification = await vi.importActual<typeof gatewayVerification>(
        "./update-command-verification.js",
      );
      mocks.verifyGateway.mockImplementationOnce(verification.verifyUpdatedGateway);
      const observation = vi
        .spyOn(await import("./update-command-readiness.js"), "observeUpdateGatewayReadiness")
        .mockImplementationOnce(async (params) => {
          expect(maintenance.finish).toHaveBeenCalledOnce();
          expect(maintenance.release).toHaveBeenCalledOnce();
          expect(listUpdateRuns()[0]?.status).toBe("running");
          return {
            health: {
              healthy: true,
              runtime: { status: "running", pid: 4242 },
              portUsage: { port: params.gatewayPort, status: "busy", listeners: [], hints: [] },
              staleGatewayPids: [],
              gatewayVersion: "2026.9.4",
              expectedVersion: params.expectedVersion,
            },
            readyz: true,
            http: undefined,
            launchAgentRecovery: null,
          };
        });
      const message =
        "Doctor could not enter maintenance. Error: The update parent owns Gateway activation.";
      vi.mocked(runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(
        new UpdateDoctorError(message, [{ check: "doctor", code: "doctor-failed", message }], {
          exitCode: 23,
        }),
      );
      mocks.triage.mockImplementationOnce(async () => {
        expect(listUpdateRuns()[0]).toMatchObject({
          status: "failed",
          reason: "doctor-failed",
          target: { kind: "package", version: "2026.9.4" },
          after: { version: "2026.9.4" },
        });
        return { status: "completed", hint: "fixture" };
      });
      await expect(
        updateFinalizeCommand({ json: !interactive, yes: !interactive }),
      ).rejects.toThrow(message);
      if (interactive) {
        const body = vi
          .mocked(defaultRuntime.log)
          .mock.calls.map(([value]) => String(value))
          .find((value) => value.startsWith("# OpenClaw update failure report"));
        expect(body).toBeDefined();
        expect(body).toContain("Reason code: doctor-failed");
        expect(body).toContain("Update mode: package");
        expect(body).toContain("Update target: 2026.9.4");
        expect(body).toContain("Failed phase finalize-doctor: exit 23");
        expect(body).toContain(`Failing check doctor (doctor-failed): ${message}`);
        expect(body).toContain("Recovery outcome: verified serving 2026.9.4");
        expect(mocks.triage).not.toHaveBeenCalled();
      } else {
        expect(mocks.triage).toHaveBeenCalledOnce();
      }
      expect(listUpdateRuns()).toHaveLength(1);
      expect(mocks.maintenance).toHaveBeenCalledOnce();
      expect(observation).toHaveBeenCalledOnce();
      expect(listUpdateRuns()[0]?.verification).toMatchObject({
        serviceRunning: true,
        runningVersion: "2026.9.4",
        versionMatch: true,
        readyz: true,
        recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.4" },
      });
      closeOpenClawStateDatabaseForTest();
      expect(listUpdateRuns()[0]?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ step: "finalize:doctor", status: "failed", exitCode: 23 }),
          expect.objectContaining({
            step: "finalize:package-rollback-not-needed",
            status: "skipped",
          }),
        ]),
      );
    },
  );

  it.each([false, true])(
    "leaves rollback with the post-core driver (run ID=%s)",
    async (inherited) => {
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      if (inherited) {
        vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", createUpdateRun({ trigger: "cli" }).runId);
      }
      vi.mocked(runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(
        new Error("Doctor failed"),
      );
      await expect(finalize()).rejects.toThrow("Doctor failed");
      const run = listUpdateRuns()[0]!;
      expect(run).toMatchObject({
        status: inherited ? "running" : "failed",
        reason: "finalize:doctor",
      });
      expect(run.steps.some((step) => step.step === "finalize:package-rollback-not-needed")).toBe(
        false,
      );
      expect(mocks.triage).not.toHaveBeenCalled();
    },
  );

  it("converges an already-current installation in its changed runtime root", async () => {
    const result = await convergeCurrent({
      result: resultFixture("/tmp/openclaw", {
        status: "skipped",
        reason: "already-current",
        before: { version: VERSION },
        after: { version: VERSION },
      }),
      root: "/tmp/openclaw",
      previousInstallRoot: "/tmp/openclaw-source",
    });
    expect(mocks.events).toEqual(["target-convergence:false"]);
    expectNoCalls(updatePluginsAfterCoreUpdate, completePostCorePluginUpdate);
    expect(result.resultWithPostUpdate).toMatchObject({
      status: "skipped",
      reason: "already-current",
    });
  });

  registerConvergenceCompletionTests({ mocks, validConfigSnapshot, successfulPluginUpdate });

  it("keeps the plugin and error class when convergence fails", async () => {
    const failure = {
      code: "incompatible_plugin_api",
      pluginId: "example",
      message: "Plugin requires a newer host API.",
    };
    vi.mocked(updatePluginsAfterCoreUpdate).mockResolvedValueOnce({
      ...successfulPluginUpdate,
      status: "error",
      changed: false,
      npm: {
        changed: false,
        outcomes: [{ ...failure, status: "error" }],
      },
    });
    const { resultWithPostUpdate } = await convergeCurrent();
    expect(resultWithPostUpdate.steps).toContainEqual(
      expect.objectContaining({
        exitCode: 1,
        failureFacts: [{ check: "plugin-update", ...failure }],
      }),
    );
  });

  it.each(["live", "unset selectors"] as const)(
    "preserves the %s invocation environment through a failed phase",
    async (source) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/fixture/invocation-state");
      vi.stubEnv("OPENCLAW_PROFILE", "caller-profile");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");
      const failure = new Error("phase failed");
      const env = source === "live" ? process.env : { ...process.env };
      if (source === "unset selectors") {
        env.OPENCLAW_PROFILE = undefined;
        env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE = undefined;
      }
      let observed: NodeJS.ProcessEnv | undefined;
      try {
        await expect(
          withOwnedManagedUpdateEnv(env, async () => {
            await Promise.resolve();
            observed = { ...process.env };
            process.env.OPENCLAW_STATE_DIR = "/fixture/phase-state";
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(observed?.OPENCLAW_STATE_DIR).toBe("/fixture/invocation-state");
        expect(process.env.OPENCLAW_STATE_DIR).toBe("/fixture/invocation-state");
        if (source === "unset selectors") {
          expect(observed).not.toHaveProperty("OPENCLAW_PROFILE");
          expect(observed).not.toHaveProperty("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE");
          expect(process.env.OPENCLAW_PROFILE).toBe("caller-profile");
          expect(process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBe("1");
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("forwards prepared source runtime from the parent handoff", async () => {
    const handoff = dirs.make("prepared-source-runtime-");
    await writeFixtureJson(path.join(handoff, "handoff.json"), {
      completionOwner: "parent",
      sourceRuntimePrepared: true,
    });
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", path.join(handoff, "plugins.json"));
    await resumePostCoreUpdate({
      root: "/tmp/openclaw",
      channel: "stable",
      opts: { yes: true },
      timeoutMs: 1_000,
    });
    expectLifecycleBoundary(mocks.events, "handoff-records");
    expectPartialCall(completeSourceUpdateRuntime, { sourceRuntimePrepared: true });
  });

  it.each(["success", "doctor", "plugins"])(
    "restores legacy post-core service custody before publishing %s",
    async (phase) => {
      const failure = new Error(`Synthetic ${phase} failure`);
      const finish = vi.fn(async () => {
        record("restore-service");
      });
      mocks.maintenance.mockImplementationOnce(async () => {
        record("park-service");
        return createDoctorMaintenanceFixture({
          releaseState: async () => {
            record("release-state");
          },
          finish,
          release: async () => {
            record("release-custody");
          },
        });
      });
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", "/fixture/post-core-result.json");
      const publish = async () => {
        expect(finish).toHaveBeenCalledOnce();
        record("publish");
      };
      vi.mocked(writePostCorePluginUpdateResultFile).mockImplementationOnce(publish);
      vi.mocked(writePostCoreUpdateFailureFile).mockImplementationOnce(publish);
      if (phase === "doctor") {
        vi.mocked(runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(failure);
      } else if (phase === "plugins") {
        vi.mocked(updatePluginsAfterCoreUpdate).mockRejectedValueOnce(failure);
      }
      const run = resumePostCoreUpdate({
        root: "/tmp/openclaw",
        channel: "stable",
        opts: { yes: true },
        timeoutMs: 1_000,
      });
      if (phase === "success") {
        await run;
      } else {
        await expect(run).rejects.toBe(failure);
      }
      expect(finish).toHaveBeenCalledOnce();
      expect(mocks.events.indexOf("release-state:false")).toBeGreaterThan(
        mocks.events.indexOf("park-service:false"),
      );
      expect(mocks.events.indexOf("publish:false")).toBeGreaterThan(
        mocks.events.indexOf("restore-service:false"),
      );
    },
  );

  it.each([undefined, "5"])("forwards the finalizer Doctor timeout %s", async (timeout) => {
    await finalize({
      channel: "stable",
      deferCompletionCache: true,
      timeout,
    });
    const expected = expect.objectContaining({
      timeoutMs: timeout === undefined ? undefined : 5_000,
    });
    expect(runUpdateFinalizationDoctorInFreshProcess).toHaveBeenCalledWith(expected);
    expect(completePostCorePluginUpdate).toHaveBeenCalledWith(expected);
  });

  it.each(finalizationCleanupCases)(
    "joins finalizer cleanup before publication ($phase, $cleanup, failure=$failed)",
    async ({ phase, cleanup, failed }) => {
      const custody = createRetainedCleanupFixture();
      const originalError = new Error("Finalization was cancelled");
      if (phase === "recovery") {
        await writeFixtureJson(path.join(await resolveUpdateRoot(), "package.json"), {
          name: "openclaw",
          version: VERSION,
        });
        mocks.verifyGateway.mockImplementationOnce(async () => {
          custody.retain();
          return { ok: true, summary: "healthy" };
        });
      }
      // Keep the real finalizer, lifecycle, ledger, and process scopes; discovery
      // and the completion subprocess are the only deferred boundaries here.
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockImplementationOnce(async () => {
        if (phase === "preflight") {
          custody.retain();
        }
        return "package";
      });
      vi.mocked(tryWriteCompletionCache)
        .mockReset()
        .mockResolvedValue("completed")
        .mockImplementationOnce(async () => {
          if (phase === "completion") {
            custody.retain();
          }
          if (failed) {
            throw originalError;
          }
          return "completed";
        });
      // An explicit phase budget bypasses the native database-size probe.
      const error = await custody.settle(finalize({ timeout: "5" }), cleanup, () => {
        expectNoCalls(defaultRuntime.writeJson, mocks.triage);
        expect(listUpdateRuns()[0]?.status).toBe("running");
        if (phase === "preflight") {
          expect(runUpdateFinalizationDoctorInFreshProcess).not.toHaveBeenCalled();
        }
      });
      if (cleanup === "uncertain") {
        expect(error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
        if (failed) {
          expect(collectNestedErrorCandidates(error)).toContain(originalError);
        }
        expectNoCalls(defaultRuntime.writeJson, mocks.triage);
        expect(listUpdateRuns()[0]?.status).not.toBe("succeeded");
        if (phase === "recovery") {
          expect(listUpdateRuns()[0]?.status).toBe("running");
        }
      } else if (failed) {
        expect(error).toBe(originalError);
        expect(listUpdateRuns()[0]?.status).toBe("failed");
        expect(mocks.triage).toHaveBeenCalledOnce();
      } else {
        expect(error).toBeUndefined();
        expectPartialCall(defaultRuntime.writeJson, { status: "ok", mode: "finalize" });
        expect(listUpdateRuns()[0]?.status).toBe("succeeded");
      }
    },
  );

  it.each(
    (["doctor", "convergence", "restoration"] as const).flatMap((phase) =>
      (["forced", "uncertain"] as const).map((cleanup) => ({ phase, cleanup })),
    ),
  )(
    "settles repair custody before restoration and publication ($phase, $cleanup)",
    async ({ phase, cleanup }) => {
      const custody = createRetainedCleanupFixture();
      const originalError = new Error("Repair Doctor failed");
      const maintenance = createDoctorMaintenanceFixture();
      const { finish, release, releaseState } = maintenance;
      vi.mocked(finish).mockImplementation(async () => {
        if (phase === "restoration") {
          custody.retain();
        }
      });
      mocks.maintenance.mockResolvedValue(maintenance);
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
      // Reconciliation is observed; the invocation still uses its real ledger.
      const reconcile = vi
        .spyOn(updateLedger, "reconcileAbandonedUpdateRunsAsync")
        .mockResolvedValue([]);
      const acknowledge = vi
        .spyOn(updateLedger, "acknowledgeAbandonedUpdateRun")
        .mockReturnValue(true);
      const expectUnpublished = () => {
        expectNoCalls(reconcile, acknowledge, defaultRuntime.writeJson);
      };
      const expectCustodyHeld = () => {
        expect(finish).toHaveBeenCalledTimes(phase === "restoration" ? 1 : 0);
        expectUnpublished();
        expectNoCalls(release, mocks.triage);
      };
      if (phase === "convergence") {
        vi.mocked(completePostCorePluginUpdate).mockImplementationOnce(async () => {
          custody.retain();
          return { pluginUpdate: successfulPluginUpdate, configSnapshot: validConfigSnapshot };
        });
      } else {
        vi.mocked(runUpdateFinalizationDoctorInFreshProcess).mockImplementationOnce(async () => {
          if (phase === "doctor") {
            custody.retain();
          }
          throw originalError;
        });
      }
      const error = await custody.settle(
        finalize({ timeout: "5", deferCompletionCache: true }, ["synthetic-retained-run"]),
        cleanup,
        () => {
          expectCustodyHeld();
          expect(listUpdateRuns()[0]?.status).toBe("running");
        },
      );
      expect(releaseState).toHaveBeenCalledOnce();
      if (cleanup === "uncertain") {
        expect(hasCommandProcessCleanupError(error)).toBe(true);
        if (phase !== "convergence") {
          expect(collectNestedErrorCandidates(error)).toContain(originalError);
        }
        expectCustodyHeld();
        expect(listUpdateRuns()[0]?.status).not.toBe("succeeded");
      } else {
        expect(vi.mocked(finish).mock.calls).toEqual([[validConfigSnapshot.config]]);
        const converged = phase === "convergence";
        expect(error).toBe(converged ? undefined : originalError);
        expect(release).toHaveBeenCalledTimes(converged ? 0 : 1);
        expect(mocks.triage).toHaveBeenCalledTimes(converged ? 0 : 1);
        expect(listUpdateRuns()[0]?.status).toBe(converged ? "succeeded" : "failed");
        if (converged) {
          expect(reconcile).toHaveBeenCalledWith({
            explicit: true,
            runIds: ["synthetic-retained-run"],
          });
          expect(acknowledge).toHaveBeenCalledWith("synthetic-retained-run");
          expectPartialCall(defaultRuntime.writeJson, { status: "ok", mode: "finalize" });
        } else {
          expectUnpublished();
        }
      }
    },
  );

  it.each(["restoration", "doctor"] as const)(
    "keeps nonfatal %s warnings in terminal JSON without failing finalization",
    async (source) => {
      const warning =
        source === "restoration"
          ? "Gateway was already stopped before repair; run openclaw gateway start."
          : "Optional version probe timed out; recheck after restart.";
      if (source === "restoration") {
        const warnings: string[] = [];
        mocks.maintenance.mockResolvedValue(
          createDoctorMaintenanceFixture({
            finish: async () => {
              warnings.push(warning);
            },
            warnings,
          }),
        );
        vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
      } else {
        mocks.doctorWarnings = [warning];
      }
      await finalize(
        {
          deferCompletionCache: true,
          timeout: source === "restoration" ? "5" : undefined,
        },
        source === "restoration" ? [] : undefined,
      );

      expectPartialCall(defaultRuntime.writeJson, {
        status: "warning",
        restart: false,
        postUpdate: expect.objectContaining({
          doctor: { status: "warning", warnings: [warning] },
        }),
      });
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    },
  );
});
