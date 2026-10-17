import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDoctorMaintenanceFixture } from "../../commands/doctor-maintenance.test-support.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import * as updateCheck from "../../infra/update-check.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { defaultRuntime as runtime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { VERSION } from "../../version.js";
import {
  expectNoCalls,
  expectPartialCall,
} from "../daemon-cli/lifecycle-assertions.test-support.js";
import {
  registerAbandonedRepairHistoryTests,
  registerRepairCustodyTests,
  createRetainedCleanupFixture,
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

async function recordResult<T>(name: string, result: T): Promise<T> {
  record(name);
  return result;
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
  loadInstalledPluginIndexInstallRecords: vi.fn(() => recordResult("installed-records", {})),
}));

vi.mock("../../plugins/installed-plugin-index-store.js", () => ({
  readPersistedInstalledPluginIndex: vi.fn(() => recordResult("persisted-index", null)),
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

vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: vi.fn(() => recordResult("config-snapshot", undefined)),
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
  completePostCorePluginUpdate: vi.fn(() =>
    recordResult("complete", {
      pluginUpdate: successfulPluginUpdate,
      configSnapshot: validConfigSnapshot,
    }),
  ),
  runUpdateFinalizationDoctorInFreshProcess: vi.fn(
    async (params: { onWarnings?: (warnings: string[]) => void }) => {
      record("fresh-doctor");
      params.onWarnings?.(mocks.doctorWarnings);
    },
  ),
  withPrePluginUpdateDoctorEnv: async (run: () => Promise<unknown>) => await run(),
}));

vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: vi.fn(() => recordResult("plugin-update", successfulPluginUpdate)),
}));

vi.mock("./update-command-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-runtime.js")>()),
  completeSourceUpdateRuntime: vi.fn(() => recordResult("runtime-completion", { changed: false })),
}));

vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: vi.fn(),
  readPostCorePluginInstallRecordsFile: vi.fn(() => recordResult("handoff-records", {})),
  writePostCorePluginUpdateResultFile: vi.fn(async () => undefined),
  writePostCoreUpdateFailureFile: vi.fn(async () => undefined),
}));

import { readPackageVersion, resolveUpdateRoot, tryWriteCompletionCache } from "./shared.js";
import { registerConvergenceCompletionTests } from "./update-command-convergence-completion.test-support.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import {
  completePostCorePluginUpdate as completePlugins,
  runUpdateFinalizationDoctorInFreshProcess as runDoctor,
} from "./update-command-fresh-doctor.js";
import { updatePluginsAfterCoreUpdate as updatePlugins } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess as continuePostCore,
  writePostCorePluginUpdateResultFile as writePluginResult,
  writePostCoreUpdateFailureFile as writeFailure,
} from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";

function convergenceInput(
  overrides: Partial<Parameters<typeof convergeUpdatePlugins>[0]> = {},
): Parameters<typeof convergeUpdatePlugins>[0] {
  return {
    coreAlreadyCurrent: true,
    result: { status: "skipped", mode: "npm", reason: "already-current", steps: [], durationMs: 1 },
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
  };
}

const resume = () =>
  resumePostCoreUpdate({
    root: "/tmp/openclaw",
    channel: "stable",
    opts: { yes: true },
    timeoutMs: 1_000,
  });

const finalize = (opts: Parameters<typeof updateFinalizeCommand>[0] = {}, runIds?: string[]) =>
  updateFinalizeCommand({ json: true, yes: true, ...opts }, runIds);

async function writePackage(root: string, version?: string) {
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
}

function expectEventBefore(first: string, second: string) {
  expect(mocks.events.indexOf(first)).toBeLessThan(mocks.events.indexOf(second));
}

describe("update plugin lifecycle lease boundaries", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(updatePlugins).mockReset();
    vi.mocked(completePlugins).mockReset();
    vi.mocked(continuePostCore).mockReset();
    mocks.verifyGateway
      .mockReset()
      .mockResolvedValue({ ok: false, score: 0, summary: "stopped-free" });
    vi.unstubAllEnvs();
    // Ordering fixtures own private state, never a shared host recovery root.
    vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("update-lease-order-"));
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
    mocks.events = [];
    mocks.leaseActive = false;
    mocks.doctorWarnings = [];
    mocks.interactive = false;
    mocks.triage.mockReset().mockResolvedValue({ status: "completed", hint: "fixture" });
    mocks.maintenance.mockReset().mockResolvedValue(undefined);
    vi.mocked(writePluginResult).mockReset().mockResolvedValue(undefined);
    vi.mocked(writeFailure).mockReset().mockResolvedValue(undefined);
    const root = dirs.make("update-lease-package-");
    await writePackage(root);
    vi.mocked(resolveUpdateRoot).mockResolvedValue(root);
    vi.mocked(readPackageVersion).mockResolvedValue(VERSION);
    vi.mocked(continuePostCore).mockImplementation(() =>
      recordResult("target-convergence", {
        resumed: true,
        pluginUpdate: { ...successfulPluginUpdate, changed: false },
      }),
    );
    mocks.readConfig.mockImplementation(() => recordResult("read-config", validConfigSnapshot));
    vi.spyOn(runtime, "error").mockImplementation(() => undefined);
    vi.spyOn(runtime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(runtime, "log").mockImplementation(() => undefined);
    vi.spyOn(runtime, "writeJson").mockImplementation(() => undefined);
  });

  registerPrivateHandoffBindingTests();
  registerAbandonedRepairHistoryTests();

  it.each(["returned", "uncertain", "plugins", "targetConfigConvergence"] as const)(
    "settles finalizer recovery before reporting a %s failure",
    async (phase) => {
      await prepareFinalizationPackage(await resolveUpdateRoot());
      mocks.verifyGateway.mockResolvedValue({ ok: true, score: 7, summary: "healthy" });
      const returned = phase === "returned" || phase === "uncertain";
      const failure = new Error(`finalize:${phase} failed`);
      const cleanup = new CommandProcessCleanupError();
      if (returned) {
        vi.mocked(completePlugins).mockResolvedValueOnce({
          configSnapshot: validConfigSnapshot,
          pluginUpdate: { ...successfulPluginUpdate, status: "error" },
        });
      } else if (phase === "plugins") {
        vi.mocked(updatePlugins).mockRejectedValueOnce(failure);
      } else {
        vi.mocked(completePlugins).mockRejectedValueOnce(failure);
      }
      if (phase === "uncertain") {
        mocks.verifyGateway.mockRejectedValueOnce(cleanup);
      }
      const command = finalize({ timeout: returned ? undefined : "5" });
      if (phase === "uncertain") {
        const error = await command.catch((reason: unknown) => reason);
        expect(hasCommandProcessCleanupError(error)).toBe(true);
        expect(collectNestedErrorCandidates(error)).toContain(cleanup);
        expect(listUpdateRuns()[0]?.status).toBe("running");
        expectNoCalls(runtime.writeJson, mocks.triage);
        return;
      }
      const recovery = { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" };
      if (returned) {
        await expect(command).rejects.toMatchObject({ code: 1 });
        expectPartialCall(runtime.writeJson, { status: "error", recovery });
      } else {
        await expect(command).rejects.toBe(failure);
      }
      expect(mocks.verifyGateway).toHaveBeenCalledOnce();
      expect(listUpdateRuns()[0]).toMatchObject({ status: "failed", verification: { recovery } });
      expectPartialCall(mocks.triage, {
        failure: expect.objectContaining({
          result: expect.objectContaining({
            recovery: expect.objectContaining({ service: "healthy" }),
            ...(returned ? { verification: {} } : {}),
          }),
        }),
      });
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
      vi.mocked(updatePlugins).mockImplementationOnce(async () => {
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
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(unavailable.message));
    },
  );

  it.each([false, true])(
    "reports the admitted Doctor failure (interactive=%s)",
    async (interactive) => {
      mocks.interactive = interactive;
      vi.mocked(readPackageVersion).mockResolvedValue("2026.9.4");
      await writePackage(await resolveUpdateRoot(), "2026.9.4");
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
      vi.mocked(runDoctor).mockRejectedValueOnce(
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
      await expect(finalize({ json: !interactive, yes: !interactive })).rejects.toThrow(message);
      if (interactive) {
        const body = vi
          .mocked(runtime.log)
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
      vi.mocked(runDoctor).mockRejectedValueOnce(new Error("Doctor failed"));
      await expect(finalize()).rejects.toThrow("Doctor failed");
      const run = listUpdateRuns()[0]!;
      expect(run).toMatchObject({
        status: inherited ? "running" : "failed",
        reason: "finalize:doctor",
      });
      expect(run.steps.map((step) => step.step)).not.toContain(
        "finalize:package-rollback-not-needed",
      );
      expect(mocks.triage).not.toHaveBeenCalled();
    },
  );

  it.each([
    { installedVersion: VERSION, previousInstallRoot: "/tmp/openclaw" },
    { installedVersion: "2026.8.27", previousInstallRoot: "/tmp/openclaw" },
    { installedVersion: VERSION, previousInstallRoot: "/tmp/openclaw-source" },
  ])(
    "keeps already-current $installedVersion convergence owned by its runtime from $previousInstallRoot",
    async ({ installedVersion, previousInstallRoot }) => {
      const needsTargetRuntime =
        installedVersion !== VERSION || previousInstallRoot !== "/tmp/openclaw";
      vi.mocked(readPackageVersion).mockResolvedValue(installedVersion);
      if (!needsTargetRuntime) {
        vi.mocked(updatePlugins).mockImplementationOnce(() =>
          recordResult("plugin-update", {
            ...successfulPluginUpdate,
            assessment: { kind: "no-payload-repair" as const },
            changed: false,
          }),
        );
      }
      const input = convergenceInput({ root: "/tmp/openclaw", previousInstallRoot });
      input.result = {
        ...input.result,
        root: input.root,
        before: { version: installedVersion },
        after: { version: installedVersion },
      };
      const result = await convergeUpdatePlugins(input);

      if (needsTargetRuntime) {
        expect(mocks.events).toEqual(["target-convergence:false"]);
        expectNoCalls(updatePlugins);
      } else {
        expectNoCalls(continuePostCore);
        expect(completeSourceUpdateRuntime).toHaveBeenCalledOnce();
        expect(
          mocks.events.findIndex((event) => event.startsWith("runtime-completion:")),
        ).toBeLessThan(mocks.events.indexOf("plugin-update:true"));
        expect(mocks.events).toContain("plugin-update:true");
      }
      expectNoCalls(completePlugins);
      expect(result.resultWithPostUpdate).toMatchObject({
        status: "skipped",
        reason: "already-current",
      });
    },
  );

  registerConvergenceCompletionTests({ mocks, validConfigSnapshot, successfulPluginUpdate });

  it("keeps the plugin and error class when convergence fails", async () => {
    const pluginError = {
      pluginId: "example",
      code: "incompatible_plugin_api",
      message: "Plugin requires a newer host API.",
    };
    vi.mocked(updatePlugins).mockResolvedValueOnce({
      ...successfulPluginUpdate,
      status: "error",
      assessment: { kind: "unsafe", reason: "convergence-failed" },
      changed: false,
      npm: {
        changed: false,
        outcomes: [{ ...pluginError, status: "error" }],
      },
    });
    const { resultWithPostUpdate } = await convergeUpdatePlugins(convergenceInput());
    expect(resultWithPostUpdate.steps).toContainEqual(
      expect.objectContaining({
        exitCode: 1,
        failureFacts: [{ check: "plugin-update", ...pluginError }],
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

  it.each([
    { owner: undefined, sourceRuntimePrepared: false },
    { owner: "parent", sourceRuntimePrepared: false },
    { owner: "parent", sourceRuntimePrepared: true },
  ])(
    "resumes with completion owner $owner before publishing (prepared=$sourceRuntimePrepared)",
    async ({ owner, sourceRuntimePrepared }) => {
      const handoff = dirs.make("prepared-source-runtime-");
      await fs.writeFile(
        path.join(handoff, "handoff.json"),
        JSON.stringify({ completionOwner: owner, sourceRuntimePrepared }),
      );
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", path.join(handoff, "plugins.json"));
      vi.mocked(writePluginResult).mockImplementationOnce(async () => {
        record("publish-result");
      });
      await resume();

      expectLifecycleBoundary(mocks.events, "handoff-records");
      expectPartialCall(completeSourceUpdateRuntime, { sourceRuntimePrepared });
      expect(
        mocks.events.findIndex((event) => event.startsWith("runtime-completion:")),
      ).toBeLessThan(mocks.events.indexOf("prepare-config:true"));
      expect(mocks.events.includes("fresh-doctor:false")).toBe(owner === undefined);
      expect(mocks.events).not.toContain("fresh-doctor:true");
      expect(mocks.events).not.toContain("config-snapshot:false");
      expect(mocks.events).not.toContain("config-snapshot:true");
      expect(mocks.events.includes("complete:false")).toBe(owner === undefined);
      expect(mocks.events).not.toContain("complete:true");
      expect(mocks.events).toContain("persisted-index:true");
      if (owner === undefined) {
        expectEventBefore("fresh-doctor:false", "prepare-config:true");
        expect(mocks.events.indexOf("complete:false")).toBeGreaterThan(
          mocks.events.lastIndexOf("lease-exit:false"),
        );
        expectEventBefore("complete:false", "publish-result:false");
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
      vi.mocked(writePluginResult).mockImplementationOnce(publish);
      vi.mocked(writeFailure).mockImplementationOnce(publish);
      if (phase === "doctor") {
        vi.mocked(runDoctor).mockRejectedValueOnce(failure);
      } else if (phase === "plugins") {
        vi.mocked(updatePlugins).mockRejectedValueOnce(failure);
      }
      const run = resume();
      if (phase === "success") {
        await run;
      } else {
        await expect(run).rejects.toBe(failure);
      }
      expect(finish).toHaveBeenCalledOnce();
      expectEventBefore("park-service:false", "release-state:false");
      expectEventBefore("restore-service:false", "publish:false");
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
      const custody = createRetainedCleanupFixture();
      const originalError = new Error("Finalization was cancelled");
      if (phase === "recovery") {
        await writePackage(await resolveUpdateRoot(), VERSION);
        mocks.verifyGateway.mockImplementationOnce(async () => {
          custody.retain();
          return { ok: true, score: 7, summary: "healthy" };
        });
      }
      // Defer only discovery/completion; keep lifecycle, ledger, and process scopes real.
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
      const error = await custody.settle(finalize({ timeout: "5" }), cleanup, () => {
        expectNoCalls(runtime.writeJson, mocks.triage);
        expect(listUpdateRuns()[0]?.status).toBe("running");
        if (phase === "preflight") {
          expect(runDoctor).not.toHaveBeenCalled();
        }
      });
      if (cleanup === "uncertain") {
        expect(error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
        if (failed) {
          expect(collectNestedErrorCandidates(error)).toContain(originalError);
        }
        expectNoCalls(runtime.writeJson, mocks.triage);
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
        expectPartialCall(runtime.writeJson, { status: "ok", mode: "finalize" });
        expect(listUpdateRuns()[0]?.status).toBe("succeeded");
      }
    },
  );

  registerRepairCustodyTests(mocks);

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

      expectPartialCall(runtime.writeJson, {
        status: "warning",
        restart: false,
        postUpdate: expect.objectContaining({
          doctor: { status: "warning", warnings: [warning] },
        }),
      });
      expect(runtime.exit).not.toHaveBeenCalledWith(1);
    },
  );
});
