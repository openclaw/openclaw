import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import * as updateCheck from "../../infra/update-check.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { VERSION } from "../../version.js";
import {
  registerAbandonedRepairHistoryTests,
  registerRepairCustodyTests,
} from "./update-command-lifecycle-repair.test-support.js";
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

vi.mock("../../plugins/installed-plugin-index-store.js", () => ({
  readPersistedInstalledPluginIndex: vi.fn(async () => {
    record("persisted-index");
    return null;
  }),
}));

vi.mock("../../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_params: unknown, run: () => Promise<unknown>) => {
    mocks.events.push("lease-enter:false");
    mocks.leaseActive = true;
    try {
      return await run();
    } finally {
      mocks.leaseActive = false;
      mocks.events.push("lease-exit:false");
    }
  },
}));

vi.mock("../../state/openclaw-state-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-ownership.js")>()),
  assertOpenClawStateWriteAllowedAtPath: vi.fn(async () => undefined),
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  readPackageVersion: vi.fn(async () => "2026.8.27"),
  resolveUpdateRoot: vi.fn(async () => "/tmp/openclaw"),
  tryWriteCompletionCache: vi.fn(async () => "completed"),
}));

vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: vi.fn(async () => {
    record("config-snapshot");
  }),
}));

vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  persistRequestedUpdateChannel: vi.fn(async (params: { configSnapshot: unknown }) => {
    record("persist-channel");
    return params.configSnapshot;
  }),
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

vi.mock("./update-command-fresh-doctor.js", () => ({
  completePostCorePluginUpdate: vi.fn(async () => {
    record("complete");
    return {
      pluginUpdate: successfulPluginUpdate,
      configSnapshot: validConfigSnapshot,
    };
  }),
  runUpdateFinalizationDoctorInFreshProcess: vi.fn(
    async (params: { onWarnings?: (warnings: string[]) => void }) => {
      record("fresh-doctor");
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
  completeSourceUpdateRuntime: vi.fn(async () => {
    record("runtime-completion");
    return { changed: false };
  }),
}));

vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: vi.fn(),
  postCoreUpdateParentOwnsCompletion: vi.fn(async () => false),
  readPostCorePluginInstallRecordsFile: vi.fn(async () => {
    record("handoff-records");
    return {};
  }),
  resolvePostCoreUpdateStartedAtMs: vi.fn(async () => 1_000),
  writePostCorePluginUpdateResultFile: vi.fn(async () => undefined),
  writePostCoreUpdateFailureFile: vi.fn(async () => undefined),
}));

import { readPackageVersion, resolveUpdateRoot, tryWriteCompletionCache } from "./shared.js";
import { registerConvergenceCompletionTests } from "./update-command-convergence-completion.test-support.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  postCoreUpdateParentOwnsCompletion,
  writePostCorePluginUpdateResultFile,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";

describe("update plugin lifecycle lease boundaries", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    // Ordering-only fixtures own an absent private state root; never probe a
    // shared host path while real recovery admission is running.
    mocks.databasePath = path.join(dirs.make("update-lease-order-"), "state", "openclaw.sqlite");
    vi.clearAllMocks();
    vi.mocked(updatePluginsAfterCoreUpdate).mockReset();
    vi.mocked(completePostCorePluginUpdate).mockReset();
    vi.mocked(continuePostCoreUpdateInFreshProcess).mockReset();
    mocks.verifyGateway
      .mockReset()
      .mockResolvedValue({ ok: false, score: 0, summary: "stopped-free" });
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
    vi.mocked(postCoreUpdateParentOwnsCompletion).mockReset().mockResolvedValue(false);
    vi.mocked(writePostCorePluginUpdateResultFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(writePostCoreUpdateFailureFile).mockReset().mockResolvedValue(undefined);
    const root = dirs.make("update-lease-package-");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
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
  registerAbandonedRepairHistoryTests();

  it.each([false, true])(
    "publishes a failed finalizer only after recovery inspection settles (uncertain=%s)",
    async (uncertain) => {
      const root = await resolveUpdateRoot();
      await prepareFinalizationPackage(root);
      mocks.verifyGateway.mockResolvedValue({ ok: true, score: 7, summary: "healthy" });
      vi.mocked(completePostCorePluginUpdate).mockResolvedValueOnce({
        configSnapshot: validConfigSnapshot,
        pluginUpdate: {
          ...successfulPluginUpdate,
          status: "error",
        },
      });
      if (uncertain) {
        const cleanup = new CommandProcessCleanupError();
        mocks.verifyGateway.mockRejectedValueOnce(cleanup);
        const failure = await updateFinalizeCommand({ json: true, yes: true }).catch(
          (error: unknown) => error,
        );
        expect(hasCommandProcessCleanupError(failure)).toBe(true);
        expect(collectNestedErrorCandidates(failure)).toContain(cleanup);
        expect(listUpdateRuns()[0]?.status).toBe("running");
        expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
        expect(mocks.triage).not.toHaveBeenCalled();
        return;
      }
      await expect(updateFinalizeCommand({ json: true, yes: true })).rejects.toMatchObject({
        code: 1,
      });
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
        }),
      );
      expect(mocks.verifyGateway).toHaveBeenCalledOnce();
      expect(listUpdateRuns()[0]?.verification.recovery).toMatchObject({ service: "healthy" });
      expect(mocks.triage).toHaveBeenCalledWith(
        expect.objectContaining({
          failure: expect.objectContaining({
            result: expect.objectContaining({
              recovery: expect.objectContaining({ service: "healthy" }),
              verification: {},
            }),
          }),
        }),
      );
    },
  );

  it.each(["read", "write", "write-provisional", "read-write"] as const)(
    "preserves the phase failure when recovery history cannot %s",
    async (operation) => {
      await prepareFinalizationPackage(await resolveUpdateRoot());
      mocks.verifyGateway.mockResolvedValue({ ok: true, score: 7, summary: "healthy" });
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
      const finalization = updateFinalizeCommand({ json: true, yes: true });
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

  it.each(["plugins", "targetConfigConvergence"] as const)(
    "records verified serving recovery when finalize:%s fails",
    async (phase) => {
      const root = await resolveUpdateRoot();
      await prepareFinalizationPackage(root);
      const verify = vi.spyOn(gatewayVerification, "verifyUpdatedGateway").mockResolvedValue({
        ok: true,
        score: 7,
        summary: "Gateway version and readiness verified.",
      });
      const error = new Error(`finalize:${phase} failed`);
      if (phase === "plugins") {
        vi.mocked(updatePluginsAfterCoreUpdate).mockRejectedValueOnce(error);
      } else {
        vi.mocked(completePostCorePluginUpdate).mockRejectedValueOnce(error);
      }
      await expect(updateFinalizeCommand({ json: true, yes: true, timeout: "5" })).rejects.toBe(
        error,
      );
      expect(verify).toHaveBeenCalledOnce();
      expect(listUpdateRuns()[0]).toMatchObject({
        status: "failed",
        verification: {
          recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
        },
      });
      expect(mocks.triage).toHaveBeenCalledWith(
        expect.objectContaining({
          failure: expect.objectContaining({
            result: expect.objectContaining({
              recovery: expect.objectContaining({ service: "healthy" }),
            }),
          }),
        }),
      );
    },
  );

  it.each([false, true])(
    "reports the admitted Doctor failure (interactive=%s)",
    async (interactive) => {
      mocks.interactive = interactive;
      vi.mocked(readPackageVersion).mockResolvedValue("2026.9.4");
      await fs.writeFile(
        path.join(await resolveUpdateRoot(), "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
      );
      const maintenance = {
        signal: new AbortController().signal,
        run: <T>(operation: () => T): T => operation(),
        finish: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
        releaseState: vi.fn(async () => {}),
      };
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
      expect(listUpdateRuns()[0]?.steps).toContainEqual(
        expect.objectContaining({ step: "finalize:doctor", status: "failed", exitCode: 23 }),
      );
      expect(listUpdateRuns()[0]?.steps).toContainEqual(
        expect.objectContaining({
          step: "finalize:package-rollback-not-needed",
          status: "skipped",
        }),
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
      await expect(updateFinalizeCommand({ json: true, yes: true })).rejects.toThrow(
        "Doctor failed",
      );
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

  it.each([
    { installedVersion: VERSION, previousInstallRoot: "/tmp/openclaw", resumed: true },
    { installedVersion: "2026.8.27", previousInstallRoot: "/tmp/openclaw", resumed: true },
    { installedVersion: "2026.8.27", previousInstallRoot: "/tmp/openclaw", resumed: false },
    { installedVersion: VERSION, previousInstallRoot: "/tmp/openclaw-source", resumed: true },
  ])(
    "keeps already-current $installedVersion convergence owned by its runtime from $previousInstallRoot (resumed=$resumed)",
    async ({ installedVersion, previousInstallRoot, resumed }) => {
      const needsTargetRuntime =
        installedVersion !== VERSION || previousInstallRoot !== "/tmp/openclaw";
      vi.mocked(readPackageVersion).mockResolvedValue(installedVersion);
      if (!needsTargetRuntime) {
        vi.mocked(updatePluginsAfterCoreUpdate).mockImplementationOnce(async () => {
          record("plugin-update");
          return {
            ...successfulPluginUpdate,
            assessment: { kind: "no-payload-repair" as const },
            changed: false,
          };
        });
      }
      vi.mocked(continuePostCoreUpdateInFreshProcess).mockImplementation(async () => {
        record("target-convergence");
        return {
          resumed,
          ...(resumed ? { pluginUpdate: { ...successfulPluginUpdate, changed: false } } : {}),
        };
      });

      const result = await convergeUpdatePlugins({
        coreAlreadyCurrent: true,
        result: {
          status: "skipped",
          mode: "npm",
          root: "/tmp/openclaw",
          reason: "already-current",
          before: { version: installedVersion },
          after: { version: installedVersion },
          steps: [],
          durationMs: 1,
        },
        root: "/tmp/openclaw",
        previousInstallRoot,
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
      });

      if (needsTargetRuntime) {
        expect(mocks.events).toEqual(["target-convergence:false"]);
        expect(updatePluginsAfterCoreUpdate).not.toHaveBeenCalled();
      } else {
        expect(continuePostCoreUpdateInFreshProcess).not.toHaveBeenCalled();
        expect(mocks.events.slice(0, 3)).toEqual([
          "lease-enter:false",
          "runtime-completion:true",
          "lease-exit:false",
        ]);
        expect(mocks.events).toContain("plugin-update:true");
      }
      expect(completePostCorePluginUpdate).not.toHaveBeenCalled();
      expect(result.resultWithPostUpdate).toMatchObject(
        resumed
          ? { status: "skipped", reason: "already-current" }
          : { status: "error", reason: "post-core-update-failed" },
      );
    },
  );

  registerConvergenceCompletionTests({ mocks, validConfigSnapshot, successfulPluginUpdate });

  it("keeps the plugin and error class when convergence fails", async () => {
    vi.mocked(updatePluginsAfterCoreUpdate).mockResolvedValueOnce({
      ...successfulPluginUpdate,
      status: "error",
      assessment: { kind: "unsafe", reason: "convergence-failed" },
      changed: false,
      npm: {
        changed: false,
        outcomes: [
          {
            pluginId: "example",
            status: "error",
            code: "incompatible_plugin_api",
            message: "Plugin requires a newer host API.",
          },
        ],
      },
    });
    const { resultWithPostUpdate } = await convergeUpdatePlugins({
      coreAlreadyCurrent: true,
      result: {
        status: "skipped",
        mode: "npm",
        reason: "already-current",
        steps: [],
        durationMs: 1,
      },
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
      updateStepTimeoutMs: 1000,
    });
    expect(resultWithPostUpdate.steps).toContainEqual(
      expect.objectContaining({
        exitCode: 1,
        failureFacts: [
          {
            check: "plugin-update",
            code: "incompatible_plugin_api",
            pluginId: "example",
            message: "Plugin requires a newer host API.",
          },
        ],
      }),
    );
  });

  it.each(["copied", "live"] as const)(
    "preserves the %s invocation environment through a failed phase",
    async (source) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/fixture/invocation-state");
      const failure = new Error("phase failed");
      let observedStateDir: string | undefined;
      try {
        await expect(
          withOwnedManagedUpdateEnv(
            source === "live" ? process.env : { ...process.env },
            async () => {
              observedStateDir = process.env.OPENCLAW_STATE_DIR;
              process.env.OPENCLAW_STATE_DIR = "/fixture/phase-state";
              throw failure;
            },
          ),
        ).rejects.toBe(failure);
        expect(observedStateDir).toBe("/fixture/invocation-state");
        expect(process.env.OPENCLAW_STATE_DIR).toBe("/fixture/invocation-state");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps explicitly unset candidate selectors absent and restores the caller on failure", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "caller-profile");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");
    const failure = new Error("candidate phase failed");
    let observed: NodeJS.ProcessEnv | undefined;
    try {
      await expect(
        withOwnedManagedUpdateEnv(
          {
            ...process.env,
            OPENCLAW_PROFILE: undefined,
            OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
          },
          async () => {
            await Promise.resolve();
            observed = { ...process.env };
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
      expect(observed).not.toHaveProperty("OPENCLAW_PROFILE");
      expect(observed).not.toHaveProperty("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE");
      expect(process.env.OPENCLAW_PROFILE).toBe("caller-profile");
      expect(process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBe("1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { owner: undefined, sourceRuntimePrepared: false },
    { owner: "parent", sourceRuntimePrepared: false },
    { owner: "parent", sourceRuntimePrepared: true },
  ])(
    "resumes with completion owner $owner before publishing (prepared=$sourceRuntimePrepared)",
    async ({ owner, sourceRuntimePrepared }) => {
      vi.mocked(postCoreUpdateParentOwnsCompletion).mockResolvedValue(owner === "parent");
      const handoff = dirs.make("prepared-source-runtime-");
      await fs.writeFile(
        path.join(handoff, "handoff.json"),
        JSON.stringify({ sourceRuntimePrepared }),
      );
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", path.join(handoff, "plugins.json"));
      vi.mocked(writePostCorePluginUpdateResultFile).mockImplementationOnce(async () => {
        record("publish-result");
      });
      await resumePostCoreUpdate({
        root: "/tmp/openclaw",
        channel: "stable",
        opts: { yes: true },
        timeoutMs: 1_000,
      });

      expectLifecycleBoundary(mocks.events, "handoff-records");
      expect(completeSourceUpdateRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ sourceRuntimePrepared }),
      );
      expect(mocks.events.indexOf("runtime-completion:true")).toBeGreaterThan(
        mocks.events.indexOf("lease-enter:false"),
      );
      expect(mocks.events.indexOf("runtime-completion:true")).toBeLessThan(
        mocks.events.indexOf("prepare-config:true"),
      );
      expect(mocks.events.includes("fresh-doctor:false")).toBe(owner === undefined);
      expect(mocks.events).not.toContain("fresh-doctor:true");
      expect(mocks.events).not.toContain("config-snapshot:false");
      expect(mocks.events).not.toContain("config-snapshot:true");
      expect(mocks.events.includes("complete:false")).toBe(owner === undefined);
      expect(mocks.events).not.toContain("complete:true");
      expect(mocks.events).toContain("persisted-index:true");
      if (owner === undefined) {
        expect(mocks.events.indexOf("fresh-doctor:false")).toBeLessThan(
          mocks.events.indexOf("prepare-config:true"),
        );
        expect(mocks.events.indexOf("complete:false")).toBeGreaterThan(
          mocks.events.lastIndexOf("lease-exit:false"),
        );
        expect(mocks.events.indexOf("publish-result:false")).toBeGreaterThan(
          mocks.events.indexOf("complete:false"),
        );
      }
    },
  );

  it.each(["success", "doctor", "plugins"])(
    "restores legacy post-core service custody before publishing %s",
    async (phase) => {
      const failure = new Error(`Synthetic ${phase} failure`);
      const finish = vi.fn(async () => {
        record("restore-service");
      });
      mocks.maintenance.mockImplementationOnce(async () => {
        record("park-service");
        return {
          signal: new AbortController().signal,
          run: <T>(operation: () => T): T => operation(),
          releaseState: async () => {
            record("release-state");
          },
          finish,
          release: async () => {
            record("release-custody");
          },
        };
      });
      vi.mocked(postCoreUpdateParentOwnsCompletion).mockResolvedValueOnce(false);
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

  it.each([undefined, "5"])(
    "runs finalizer doctors outside the lease with timeout %s",
    async (timeout) => {
      await updateFinalizeCommand({
        channel: "stable",
        deferCompletionCache: true,
        json: true,
        yes: true,
        timeout,
      });

      expectLifecycleBoundary(mocks.events, "fresh-doctor");
      const doctorIndex = mocks.events.indexOf("fresh-doctor:false");
      expect(mocks.events.slice(0, doctorIndex)).toContain("read-config:true");
      expect(mocks.events.indexOf("complete:false")).toBeGreaterThan(
        mocks.events.lastIndexOf("lease-exit:false"),
      );
      expect(mocks.events).not.toContain("persisted-index:true");
      const timeoutMs = timeout === undefined ? undefined : 5_000;
      expect(runUpdateFinalizationDoctorInFreshProcess).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs }),
      );
      expect(completePostCorePluginUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs }),
      );
    },
  );

  it.each(finalizationCleanupCases)(
    "joins finalizer cleanup before publication ($phase, $cleanup, failure=$failed)",
    async ({ phase, cleanup, failed }) => {
      const physicalCleanup = createDeferredCore<"forced" | "uncertain">();
      const joining = createDeferredCore();
      const originalError = new Error("Finalization was cancelled");
      const retainCleanup = () => {
        retainCommandProcessCleanup(physicalCleanup.promise);
        const signal = resolveCommandProcessSignal();
        if (!signal) {
          throw new Error("Finalization lost its command scope");
        }
        signal.addEventListener("abort", () => joining.resolve(), { once: true });
      };
      if (phase === "recovery") {
        await fs.writeFile(
          path.join(await resolveUpdateRoot(), "package.json"),
          JSON.stringify({ name: "openclaw", version: VERSION }),
        );
        mocks.verifyGateway.mockImplementationOnce(async () => {
          retainCleanup();
          return { ok: true, score: 7, summary: "healthy" };
        });
      }
      // Keep the real finalizer, lifecycle, ledger, and process scopes; discovery
      // and the completion subprocess are the only deferred boundaries here.
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockImplementationOnce(async () => {
        if (phase === "preflight") {
          retainCleanup();
        }
        return "package";
      });
      vi.mocked(tryWriteCompletionCache)
        .mockReset()
        .mockResolvedValue("completed")
        .mockImplementationOnce(async () => {
          if (phase === "completion") {
            retainCleanup();
          }
          if (failed) {
            throw originalError;
          }
          return "completed";
        });
      let finished = false;
      // An explicit phase budget bypasses the native database-size probe.
      const command = updateFinalizeCommand({ json: true, yes: true, timeout: "5" }).then(
        () => {
          finished = true;
          return { error: undefined };
        },
        (error: unknown) => {
          finished = true;
          return { error };
        },
      );
      try {
        await Promise.race([
          joining.promise,
          command.then(() => {
            throw new Error("Finalization returned before joining its cleanup");
          }),
        ]);
        expect(finished).toBe(false);
        expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
        expect(listUpdateRuns()[0]?.status).toBe("running");
        expect(mocks.triage).not.toHaveBeenCalled();
        if (phase === "preflight") {
          expect(runUpdateFinalizationDoctorInFreshProcess).not.toHaveBeenCalled();
        }
      } finally {
        physicalCleanup.resolve(cleanup);
        await command;
      }
      const { error } = await command;
      if (cleanup === "uncertain") {
        expect(error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
        if (failed) {
          expect(collectNestedErrorCandidates(error)).toContain(originalError);
        }
        expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
        expect(mocks.triage).not.toHaveBeenCalled();
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
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({ status: "ok", mode: "finalize" }),
        );
        expect(listUpdateRuns()[0]?.status).toBe("succeeded");
      }
    },
  );

  registerRepairCustodyTests(mocks);

  it("includes service restoration warnings in the repair outcome", async () => {
    const warnings: string[] = [];
    const warning = "Gateway was already stopped before repair; run openclaw gateway start.";
    mocks.maintenance.mockResolvedValue({
      signal: new AbortController().signal,
      run: <T>(operation: () => T): T => operation(),
      release: async () => {},
      releaseState: async () => {},
      finish: async () => {
        warnings.push(warning);
      },
      warnings,
    });
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
    await updateFinalizeCommand(
      { json: true, yes: true, timeout: "5", deferCompletionCache: true },
      [],
    );
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "warning",
        postUpdate: expect.objectContaining({ doctor: { status: "warning", warnings: [warning] } }),
      }),
    );
  });

  it("keeps nonfatal Doctor warnings in terminal JSON without failing finalization", async () => {
    mocks.doctorWarnings = ["Optional version probe timed out; recheck after restart."];
    await updateFinalizeCommand({ json: true, yes: true, deferCompletionCache: true });

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "warning",
        restart: false,
        postUpdate: expect.objectContaining({
          doctor: { status: "warning", warnings: mocks.doctorWarnings },
        }),
      }),
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });
});
