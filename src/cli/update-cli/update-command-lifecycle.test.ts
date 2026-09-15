import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import { createUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { VERSION } from "../../version.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  leaseActive: false,
  databasePath: "",
  readConfig: vi.fn(),
  doctorWarnings: [] as string[],
  triage: vi.fn(),
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
vi.mock("./update-command-runtime.js", () => ({
  completeSourceUpdateRuntime: vi.fn(async () => {
    record("runtime-completion");
    return { changed: false };
  }),
}));

vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: vi.fn(),
  readPostCorePluginInstallRecordsFile: vi.fn(async () => {
    record("handoff-records");
    return {};
  }),
  resolvePostCoreUpdateStartedAtMs: vi.fn(async () => 1_000),
  writePostCorePluginUpdateResultFile: vi.fn(async () => undefined),
}));

import { readPackageVersion } from "./shared.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import { continuePostCoreUpdateInFreshProcess } from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

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

  beforeEach(() => {
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
    mocks.triage.mockResolvedValue({ status: "completed", hint: "fixture" });
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
          .join("\n");
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

  it("returns resumed package work without Doctor completion and rereads state under the lease", async () => {
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
    expect(mocks.events).not.toContain("fresh-doctor:false");
    expect(mocks.events).not.toContain("fresh-doctor:true");
    expect(mocks.events).not.toContain("config-snapshot:false");
    expect(mocks.events).not.toContain("config-snapshot:true");
    expect(mocks.events).not.toContain("complete:false");
    expect(mocks.events).not.toContain("complete:true");
    expect(mocks.events).toContain("persisted-index:true");
  });

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
