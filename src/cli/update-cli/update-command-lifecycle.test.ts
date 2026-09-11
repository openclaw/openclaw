import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as recoveryConfigWrites from "../../infra/update-recovery-config-writes.js";
import { defaultRuntime } from "../../runtime.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  leaseActive: false,
  databasePath: "",
  readConfig: vi.fn(),
  doctorWarnings: [] as string[],
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

// This fixture proves lease ordering; process tests cover durable ledger writes.
vi.mock("../../infra/update-run-ledger.js", () => ({
  createUpdateRun: vi.fn(() => ({ runId: "lease-order-fixture" })),
  adoptUpdateRun: vi.fn(() => ({
    origin: { driver: { host: "lease-order-fixture", pid: 1, startIdentity: "1" } },
  })),
  heartbeatUpdateRun: vi.fn(),
  recordUpdateRunStep: vi.fn(),
  finishUpdateRun: vi.fn(),
  recordUpdateRunDiagnostic: vi.fn(),
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

vi.mock("../../state/openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: vi.fn(() => mocks.databasePath),
}));

vi.mock("../../state/openclaw-state-ownership.js", () => ({
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

vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  readPostCorePluginInstallRecordsFile: vi.fn(async () => {
    record("handoff-records");
    return {};
  }),
  resolvePostCoreUpdateStartedAtMs: vi.fn(async () => 1_000),
  writePostCorePluginUpdateResultFile: vi.fn(async () => undefined),
}));

import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
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
  beforeEach(() => {
    // Ordering-only fixtures own an absent private state root; never probe a
    // shared host path while real recovery admission is running.
    mocks.databasePath = path.join(dirs.make("update-lease-order-"), "state", "openclaw.sqlite");
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.events = [];
    mocks.leaseActive = false;
    mocks.doctorWarnings = [];
    mocks.readConfig.mockImplementation(async () => {
      record("read-config");
      return validConfigSnapshot;
    });
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  });

  it("keeps an unchanged already-current update on the no-op path", async () => {
    vi.mocked(updatePluginsAfterCoreUpdate).mockResolvedValueOnce({
      ...successfulPluginUpdate,
      changed: false,
    });

    const result = await convergeUpdatePlugins({
      coreAlreadyCurrent: true,
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
    });

    expect(completePostCorePluginUpdate).not.toHaveBeenCalled();
    expect(result.resultWithPostUpdate).toMatchObject({
      status: "skipped",
      reason: "already-current",
    });
  });

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
