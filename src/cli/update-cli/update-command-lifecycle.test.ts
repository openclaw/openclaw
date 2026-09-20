import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import * as recoveryConfigWrites from "../../infra/update-recovery-config-writes.js";
import { createUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";
import * as shared from "./shared.js";
import { readPackageVersion, resolveUpdateRoot, tryWriteCompletionCache } from "./shared.js";
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
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
const mocks = vi.hoisted(() => ({
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

const validConfigSnapshot = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  valid: true,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  resolved: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

const successfulPluginUpdate = {
  status: "ok" as const,
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

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

vi.mock("../../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => {
    record("installed-records");
    return {};
  }),
}));

vi.mock("../../plugins/installed-plugin-index-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index-store.js")>()),
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

vi.mock("../../state/openclaw-state-db.paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-db.paths.js")>()),
  resolveOpenClawStateSqlitePath: vi.fn(() => mocks.databasePath),
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

vi.mock("./update-command-fresh-doctor.js", async (importOriginal) => ({
  UpdateDoctorProcessUnsettledError: (
    await importOriginal<typeof import("./update-command-fresh-doctor.js")>()
  ).UpdateDoctorProcessUnsettledError,
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

// This ordering suite isolates capture payload IO; backup/rollback suites qualify real files.
vi.mock("./update-command-backup-lifecycle.js", async (original) => ({
  ...(await original<typeof import("./update-command-backup-lifecycle.js")>()),
  createUpdateCommandBackup: vi.fn(async () => ({
    directory: "/fixture/capture",
    manifestPath: "/fixture/capture/manifest.json",
    manifestSha256: "a".repeat(64),
  })),
}));
vi.mock("../../infra/update-recovery-config-writes.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-recovery-config-writes.js")>()),
  persistUpdateRecoveryConfigWrites: vi.fn(async () => {}),
  withUpdateRecoveryConfigWrites: async (
    _backup: unknown,
    _authority: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));
vi.mock("./update-command-rollback-state.js", async (original) => ({
  ...(await original<typeof import("./update-command-rollback-state.js")>()),
  restoreUpdateRecoveryState: vi.fn(async () => ({ warnings: [] })),
}));

// Process fixtures cover runtime generation with real lifecycle ownership.
vi.mock("./update-command-runtime.js", () => ({
  completeSourceUpdateRuntime: vi.fn(async () => {
    record("runtime-completion");
    return { changed: false };
  }),
}));

vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: vi.fn(),
  postCoreUpdateParentOwnsCompletion: vi.fn(),
  readPostCorePluginInstallRecordsFile: vi.fn(async () => {
    record("handoff-records");
    return {};
  }),
  resolvePostCoreUpdateStartedAtMs: vi.fn(async () => 1_000),
  writePostCorePluginUpdateResultFile: vi.fn(async () => undefined),
  writePostCoreUpdateFailureFile: vi.fn(async () => undefined),
}));

async function withFinalizerState(operation: () => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    {
      layout: "state-only",
      scenario: "minimal",
      env: { OPENCLAW_UPDATE_RUN_ID: undefined },
    },
    async (state) => {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      });
      mocks.databasePath = state.statePath("state", "openclaw.sqlite");
      const config =
        await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
      const strict = await config
        .createConfigIO({ observe: false })
        .readConfigFileSnapshotForWrite();
      expect(strict.snapshot.valid, JSON.stringify(strict.snapshot.issues)).toBe(true);
      mocks.readConfig.mockImplementation(
        async (...params: Parameters<typeof config.readConfigFileSnapshot>) => {
          record("read-config");
          return await config.readConfigFileSnapshot(...params);
        },
      );
      const root = state.path("install");
      await fs.mkdir(root, { mode: 0o700 });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
      );
      const coordinator = state.path("coordinator");
      await fs.mkdir(coordinator, { mode: 0o700 });
      const temp = vi
        .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
        .mockReturnValue(coordinator);
      vi.mocked(shared.resolveUpdateRoot).mockResolvedValueOnce(root);
      try {
        await operation();
      } finally {
        temp.mockRestore();
      }
    },
  );
}

function expectLifecycleBoundary(preLeaseEvent: string): void {
  const preLeaseIndex = mocks.events.indexOf(`${preLeaseEvent}:false`);
  expect(preLeaseIndex).toBeGreaterThan(-1);
  expect(mocks.events).not.toContain(`${preLeaseEvent}:true`);
  const authoritativeReadIndex = mocks.events.findIndex(
    (event, index) => index > preLeaseIndex && event === "read-config:true",
  );
  expect(authoritativeReadIndex).toBeGreaterThan(preLeaseIndex);
  for (const event of ["prepare-config:true", "installed-records:true", "plugin-update:true"]) {
    expect(mocks.events).toContain(event);
  }
  expect(mocks.events.indexOf("plugin-update:true")).toBeGreaterThan(authoritativeReadIndex);
}

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
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(mocks.databasePath)));
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
    mocks.events = [];
    mocks.leaseActive = false;
    mocks.doctorWarnings = [];
    mocks.interactive = false;
    mocks.triage.mockReset().mockResolvedValue({ status: "completed", hint: "fixture" });
    mocks.maintenance
      .mockReset()
      .mockImplementation(async () => ({
        assertCurrent: () => {},
        closeStores: async () => {},
        run: <T>(operation: () => T): T => operation(),
        releaseState: async () => {},
        release: async () => {},
        finish: async () => {},
      }));
    vi.mocked(runUpdateFinalizationDoctorInFreshProcess)
      .mockReset()
      .mockImplementation(async (params) => {
        record("fresh-doctor");
        params.onWarnings?.(mocks.doctorWarnings);
      });
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

  it.each([false, true])(
    "reports the admitted Doctor failure (interactive=%s)",
    async (interactive) => {
      mocks.interactive = interactive;
      vi.mocked(readPackageVersion).mockResolvedValue("2026.9.4");
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
        expect(body).toContain("Failed phase finalize:doctor: exit 23");
        expect(body).toContain(`Failing check doctor (doctor-failed): ${message}`);
        expect(body).toContain(
          "Recovery outcome: package rollback not needed: no package mutation",
        );
        expect(mocks.triage).not.toHaveBeenCalled();
      } else {
        expect(mocks.triage).toHaveBeenCalledOnce();
      }
      expect(listUpdateRuns()).toHaveLength(1);
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

  it("does not launch Doctor when finalization is revoked during config receipt flush", async () => {
    const directory = dirs.make("update-receipt-revocation-");
    const entered = createDeferred();
    const release = createDeferred();
    const revoked = new Error("Finalization authority was revoked");
    let active = true;
    const doctorLaunch = vi.fn();
    const flush = vi
      .spyOn(recoveryConfigWrites, "persistUpdateRecoveryConfigWrites")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
    vi.mocked(completePostCorePluginUpdate).mockImplementationOnce(async (params) => {
      await params.beforeDoctor?.();
      doctorLaunch();
      return { pluginUpdate: successfulPluginUpdate, configSnapshot: validConfigSnapshot };
    });
    const convergence = convergeUpdatePlugins(
      {
        coreAlreadyCurrent: true,
        updateRecoveryBackup: {
          directory,
          manifestPath: path.join(directory, "manifest.json"),
          manifestSha256: "a".repeat(64),
        },
        result: {
          status: "skipped",
          mode: "npm",
          root: "/tmp/openclaw",
          reason: "already-current",
          before: { version: "2026.9.3" },
          after: { version: "2026.9.3" },
          steps: [],
          durationMs: 1,
        },
        root: "/tmp/openclaw",
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
      },
      () => {
        if (!active) {
          throw revoked;
        }
      },
    );
    const settled = convergence.then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    try {
      await Promise.race([entered.promise, settled]);
      expect(flush).toHaveBeenCalledOnce();
      expect(doctorLaunch).not.toHaveBeenCalled();
      active = false;
      release.resolve();
      const outcome = await settled;
      expect(doctorLaunch).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBe(revoked);
      }
    } finally {
      release.resolve();
      await settled;
      flush.mockRestore();
    }
  });

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

  it.each([undefined, "parent"])(
    "resumes with completion owner %s before publishing",
    async (owner) => {
      vi.mocked(postCoreUpdateParentOwnsCompletion).mockResolvedValueOnce(owner === "parent");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", "/fixture/post-core-result.json");
      vi.mocked(writePostCorePluginUpdateResultFile).mockImplementationOnce(async () => {
        record("publish-result");
      });
      await resumePostCoreUpdate({
        root: "/tmp/openclaw",
        channel: "stable",
        opts: { yes: true },
        timeoutMs: 1_000,
      });

      expectLifecycleBoundary("handoff-records");
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
          assertCurrent: () => {},
          closeStores: async () => {},
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
      await withFinalizerState(() =>
        updateFinalizeCommand({
          channel: "stable",
          deferCompletionCache: true,
          json: true,
          yes: true,
          timeout,
        }),
      );

      expectLifecycleBoundary("fresh-doctor");
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

  it.each([
    { phase: "preflight", cleanup: "forced", failed: false },
    { phase: "preflight", cleanup: "uncertain", failed: false },
    { phase: "completion", cleanup: "forced", failed: false },
    { phase: "completion", cleanup: "uncertain", failed: false },
    { phase: "completion", cleanup: "forced", failed: true },
    { phase: "completion", cleanup: "uncertain", failed: true },
  ] as const)(
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

  it.each(
    (["doctor", "convergence", "restoration"] as const).flatMap((phase) =>
      (["forced", "uncertain"] as const).map((cleanup) => ({ phase, cleanup })),
    ),
  )(
    "settles repair custody before restoration and publication ($phase, $cleanup)",
    async ({ phase, cleanup }) => {
      const physicalCleanup = createDeferredCore<"forced" | "uncertain">();
      const joining = createDeferredCore();
      const originalError = new Error("Repair Doctor failed");
      const retainCleanup = () => {
        retainCommandProcessCleanup(physicalCleanup.promise);
        const signal = resolveCommandProcessSignal();
        if (!signal) {
          throw new Error("Repair custody lost its command scope");
        }
        signal.addEventListener("abort", () => joining.resolve(), { once: true });
      };
      type Maintenance = NonNullable<
        Awaited<
          ReturnType<typeof import("../../commands/doctor-maintenance.js").beginDoctorMaintenance>
        >
      >;
      const finish = vi.fn<Maintenance["finish"]>().mockImplementation(async () => {
        if (phase === "restoration") {
          retainCleanup();
        }
      });
      const release = vi.fn<Maintenance["release"]>().mockResolvedValue(undefined);
      const releaseState = vi.fn<Maintenance["releaseState"]>().mockResolvedValue(undefined);
      mocks.maintenance.mockResolvedValue({
        assertCurrent: () => {},
        closeStores: async () => {},
        run: <T>(operation: () => T): T => operation(),
        finish,
        release,
        releaseState,
      });
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
      // Observe reconciliation of the selected old run without inventing a live
      // recovery record; the finalizer's own invocation still uses the real ledger.
      const ledger = await import("../../infra/update-run-ledger.js");
      const reconcile = vi.spyOn(ledger, "reconcileAbandonedUpdateRuns").mockReturnValue([]);
      const acknowledge = vi
        .spyOn(ledger, "acknowledgeAbandonedUpdateRun")
        .mockImplementation(() => {});
      if (phase === "convergence") {
        vi.mocked(completePostCorePluginUpdate).mockImplementationOnce(async () => {
          retainCleanup();
          return { pluginUpdate: successfulPluginUpdate, configSnapshot: validConfigSnapshot };
        });
      } else {
        vi.mocked(runUpdateFinalizationDoctorInFreshProcess).mockImplementationOnce(async () => {
          if (phase === "doctor") {
            retainCleanup();
          }
          throw originalError;
        });
      }
      let finished = false;
      // The explicit phase budget avoids native database-size inspection.
      const command = updateFinalizeCommand(
        { json: true, yes: true, timeout: "5", deferCompletionCache: true },
        ["synthetic-retained-run"],
      ).then(
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
            throw new Error("Repair finalization returned before physical settlement");
          }),
        ]);
        expect(finished).toBe(false);
        expect(finish).toHaveBeenCalledTimes(phase === "restoration" ? 1 : 0);
        expect(release).not.toHaveBeenCalled();
        expect(reconcile).not.toHaveBeenCalled();
        expect(acknowledge).not.toHaveBeenCalled();
        expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
        expect(mocks.triage).not.toHaveBeenCalled();
        expect(listUpdateRuns()[0]?.status).toBe("running");
      } finally {
        physicalCleanup.resolve(cleanup);
        await command;
      }
      const { error } = await command;
      expect(releaseState).toHaveBeenCalledOnce();
      if (cleanup === "uncertain") {
        expect(hasCommandProcessCleanupError(error)).toBe(true);
        if (phase !== "convergence") {
          expect(collectNestedErrorCandidates(error)).toContain(originalError);
        }
        expect(finish).toHaveBeenCalledTimes(phase === "restoration" ? 1 : 0);
        expect(release).not.toHaveBeenCalled();
        expect(reconcile).not.toHaveBeenCalled();
        expect(acknowledge).not.toHaveBeenCalled();
        expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
        expect(mocks.triage).not.toHaveBeenCalled();
        expect(listUpdateRuns()[0]?.status).not.toBe("succeeded");
      } else {
        expect(finish).toHaveBeenCalledOnce();
        expect(finish).toHaveBeenCalledWith(validConfigSnapshot.config);
        if (phase === "convergence") {
          expect(error).toBeUndefined();
          expect(release).not.toHaveBeenCalled();
          expect(reconcile).toHaveBeenCalledWith({
            explicit: true,
            runIds: ["synthetic-retained-run"],
          });
          expect(acknowledge).toHaveBeenCalledWith("synthetic-retained-run");
          expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
            expect.objectContaining({ status: "ok", mode: "finalize" }),
          );
          expect(listUpdateRuns()[0]?.status).toBe("succeeded");
        } else {
          expect(error).toBe(originalError);
          expect(release).toHaveBeenCalledOnce();
          expect(reconcile).not.toHaveBeenCalled();
          expect(acknowledge).not.toHaveBeenCalled();
          expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
          expect(mocks.triage).toHaveBeenCalledOnce();
          expect(listUpdateRuns()[0]?.status).toBe("failed");
        }
      }
    },
  );

  it("keeps nonfatal Doctor warnings in terminal JSON without failing finalization", async () => {
    mocks.doctorWarnings = ["Optional version probe timed out; recheck after restart."];
    await withFinalizerState(() =>
      updateFinalizeCommand({ json: true, yes: true, deferCompletionCache: true }),
    );

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
