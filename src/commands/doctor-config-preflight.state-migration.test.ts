// Doctor config preflight tests cover state migration preflight behavior before config repair.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "../config/io.factory.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
  type DegradedPlugin,
} from "../plugins/runtime-degraded-state.js";
import { ExitError } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  preflightStateMigrationMocks,
  resetStateMigrationPreflightMocks,
} from "./doctor-config-preflight.state-migration.test-harness.js";
import {
  expectMigrationIdentity,
  getMaybeRepairPluginOpenClawHostLinksMock,
  makePreflightConfigSnapshot,
  makeStartupConvergenceResult,
  makeQuarantinedPluginRepairConvergence,
  queueConfigSnapshot,
  registerStartupPluginConvergenceTests,
  stateCheckpointOptions,
  startupCheckpointOptions,
} from "./doctor-config-preflight.state-migration.test-helpers.js";

const maybeRepairPluginOpenClawHostLinks = getMaybeRepairPluginOpenClawHostLinksMock();
const {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyState,
  prepareLegacyStateDatabaseSchema,
  prepareDoctorDatabasePreflight,
  beginDoctorMaintenance,
  doctorMaintenanceRelease,
  noteSessionTranscriptHealth,
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyTaskStateSidecars,
  repairLegacyCronStoreWithoutPrompt,
  collectCronCodexRuntimePolicyTargetsReadOnly,
  readMigrationCheckpointStatus,
  startupMigrationLeaseHeartbeat,
  startupMigrationLeaseRelease,
  startupMigrationLease,
  acquireStartupMigrationLeaseWithWait,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
  runPostCorePluginConvergence,
  runActivePluginPayloadSmokeCheck,
  planStartupPluginConvergence,
  planPristineStartupStateMigrations,
  readConfigFileSnapshot,
  pluginMigrationFingerprint,
  readConfigFileSnapshotWithPluginMetadata,
  runWithPluginMetadataSnapshot,
  note,
  recordDeferredPluginMigrations,
} = preflightStateMigrationMocks;
const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("runDoctorConfigPreflight state migration", () => {
  beforeEach(resetStateMigrationPreflightMocks);

  it("admits unchanged tilde paths from core-only and prepared plugin snapshot readers", async () => {
    const root = tempDirs.make("openclaw-startup-config-paths-");
    const configPath = path.join(root, "openclaw.json");
    const env = {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local" },
        plugins: {
          enabled: false,
          entries: { wiki: { config: { store: { path: "~/.openclaw/wiki" } } } },
        },
      }),
    );
    const options = { env, configPath, homedir: () => root, observe: false };
    const core = await createConfigIO({
      ...options,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    const { snapshot: full } = await createConfigIO(
      options,
    ).readConfigFileSnapshotWithPluginMetadata({
      prepareValidation: "runtime",
    });

    await withEnvAsync(env, () =>
      readConfigFileSnapshot.withImplementation(
        async () => full,
        async () => {
          readConfigFileSnapshot.mockResolvedValueOnce(core);
          await runDoctorConfigPreflight(startupCheckpointOptions);
        },
      ),
    );
    expect(core.sourceConfig).toEqual(full.sourceConfig);
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalled();
  });

  it("forwards config snapshot phase measurement", async () => {
    const measure: ConfigSnapshotReadMeasure = async (_name, run) => await run();

    await runDoctorConfigPreflight({
      migrateState: false,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      measure,
    });

    expect(readConfigFileSnapshot).toHaveBeenCalledWith(expect.objectContaining({ measure }));
  });

  it("measures doctor-owned migration stages", async () => {
    const measuredStages: string[] = [];
    const measure: ConfigSnapshotReadMeasure = async (name, run) => {
      measuredStages.push(name);
      return await run();
    };

    await runDoctorConfigPreflight({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      measure,
    });

    expect(measuredStages).toEqual([
      "doctor.config-preflight.state-migrations-import",
      "doctor.config-preflight.state-dir-migrations",
      "doctor.config-preflight.config-snapshot",
      "doctor.config-preflight.plugin-plan-import",
      "doctor.config-preflight.plugin-plan",
      "doctor.config-preflight.plugin-convergence-import",
      "doctor.config-preflight.plugin-convergence",
      "doctor.config-preflight.config-snapshot",
      "doctor.config-preflight.cron-repair-import",
      "doctor.config-preflight.cron-repair",
      "doctor.config-preflight.legacy-state-migrations",
    ]);
  });

  it("measures current-checkpoint plugin verification stages", async () => {
    const measuredStages: string[] = [];
    const measure: ConfigSnapshotReadMeasure = async (name, run) => {
      measuredStages.push(name);
      return await run();
    };
    readMigrationCheckpointStatus.mockReturnValue("startup-current");

    await runDoctorConfigPreflight({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      measure,
    });

    expect(measuredStages).toEqual([
      "doctor.config-preflight.startup-checkpoint-import",
      "doctor.config-preflight.pristine-state-plan-import",
      "doctor.config-preflight.pristine-state-plan",
      "doctor.config-preflight.config-snapshot",
      "doctor.config-preflight.plugin-plan-import",
      "doctor.config-preflight.plugin-plan",
      "doctor.config-preflight.plugin-payload-verification-import",
      "doctor.config-preflight.plugin-payload-verification",
    ]);
  });

  it.each([
    { name: "uses a current state checkpoint", needed: false, warnings: [] as string[] },
    { name: "records clean state-only completion", needed: true, warnings: [] as string[] },
    { name: "leaves the checkpoint stale after a warning", needed: true, warnings: ["warning"] },
  ])("$name", async ({ needed, warnings }) => {
    vi.clearAllMocks();
    readMigrationCheckpointStatus.mockReturnValue(needed ? "stale" : "state-current");
    autoMigrateLegacyStateDir.mockResolvedValue({
      migrated: false,
      skipped: false,
      changes: [],
      warnings,
    });

    await expect(runDoctorConfigPreflight(stateCheckpointOptions)).resolves.toBeDefined();

    expect(autoMigrateLegacyState).toHaveBeenCalledTimes(needed ? 1 : 0);
    expect(planStartupPluginConvergence).toHaveBeenCalledTimes(needed ? 1 : 0);
    if (needed && warnings.length === 0) {
      expect(recordSuccessfulStateMigrations).toHaveBeenCalledWith({
        env: acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env,
        identity: expectMigrationIdentity(),
        lease: startupMigrationLease,
      });
    } else {
      expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
    }
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledTimes(needed ? 1 : 0);
  });

  it("stops renewing before releasing a lease when the admitted checkpoint is current", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    readMigrationCheckpointStatus.mockReturnValueOnce("stale").mockReturnValue("startup-current");
    startupMigrationLeaseRelease.mockImplementationOnce(() => {
      expect(vi.getTimerCount()).toBe(0);
    });
    try {
      await runDoctorConfigPreflight(startupCheckpointOptions);
      expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
      expect(autoMigrateLegacyState).not.toHaveBeenCalled();
      expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the startup guard immediately before the first state mutation", async () => {
    const beforeStateMigrations = vi.fn<(_snapshot?: unknown) => Promise<boolean>>(
      async () => true,
    );

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations,
    });

    expect(beforeStateMigrations).toHaveBeenCalledTimes(3);
    const guardOrder = beforeStateMigrations.mock.invocationCallOrder[0] ?? 0;
    const firstMutationOrder = autoMigrateLegacyStateDir.mock.invocationCallOrder[0] ?? 0;
    expect(firstMutationOrder).toBeGreaterThan(guardOrder);
    const configGuardOrder = beforeStateMigrations.mock.invocationCallOrder[2] ?? 0;
    const configMutationOrder = repairLegacyCronStoreWithoutPrompt.mock.invocationCallOrder[0] ?? 0;
    expect(configMutationOrder).toBeGreaterThan(configGuardOrder);
    expect(beforeStateMigrations.mock.calls[2]?.[0]).toMatchObject({
      valid: true,
      sourceConfig: { gateway: { mode: "local", port: 19091 } },
    });
  });

  it("skips every state migration stage when the startup guard rejects", async () => {
    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations: async () => false,
    });

    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not touch the startup checkpoint before the startup guard accepts", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        beforeStateMigrations: async () => false,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toThrow("selected config changed during startup");

    expect(readMigrationCheckpointStatus).not.toHaveBeenCalled();
    expect(acquireStartupMigrationLeaseWithWait).not.toHaveBeenCalled();
  });

  it("releases the startup lease when the fresh config guard rejects", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-original-state";
    let leaseEnv: NodeJS.ProcessEnv | undefined;
    acquireStartupMigrationLeaseWithWait.mockImplementationOnce(async ({ env }) => {
      leaseEnv = env;
      return {
        ...startupMigrationLease,
        release: vi.fn(() => {
          expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-original-state");
          startupMigrationLeaseRelease();
        }),
      };
    });
    const beforeStateMigrations = vi
      .fn<(_snapshot?: Record<string, unknown>) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-drifted-state";
        return false;
      });

    try {
      await expect(
        runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          beforeStateMigrations,
          requireStartupMigrationCheckpoint: true,
        }),
      ).rejects.toThrow("selected config changed during startup");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }

    expect(leaseEnv).not.toBe(process.env);
    expect(beforeStateMigrations).toHaveBeenCalledTimes(2);
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("releases the startup lease before propagating a deferred service exit", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const deferredExit = new ExitError(78);
    const beforeStateMigrations = vi
      .fn<(_snapshot?: Record<string, unknown>) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(deferredExit);

    await expect(
      runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        beforeStateMigrations,
        requireStartupMigrationCheckpoint: true,
      }),
    ).rejects.toBe(deferredExit);

    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("skips config-dependent migrations when the fresh snapshot guard rejects", async () => {
    const beforeStateMigrations = vi
      .fn<(snapshot?: Record<string, unknown>) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      beforeStateMigrations,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(beforeStateMigrations).toHaveBeenCalledTimes(2);
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
  });

  it("runs full state migrations after reading the config snapshot", async () => {
    const receipt: LegacyStateMigrationStepReceipt = {
      id: "plugin-doctor-state",
      phase: "shared",
      source: [{ kind: "owner", id: "plugin:test:import" }],
      target: [{ kind: "owner", id: "plugin:test:doctor-state" }],
      requiredness: "required",
      reversibility: "checkpoint-required",
      outcome: "completed",
      changes: ["imported"],
      warnings: [],
    };
    autoMigrateLegacyState.mockImplementationOnce(async (params) => {
      params?.onStepReceipt?.(receipt);
      return { migrated: true, skipped: false, changes: receipt.changes, warnings: [] };
    });
    const result = await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(readConfigFileSnapshot).toHaveBeenCalledTimes(3);
    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      migrateCodexModelRefs: false,
    });
    expect(autoMigrateLegacyState).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      configIncludedPaths: [],
      env: process.env,
      log: undefined,
      recoverCorruptTargetStore: undefined,
      doctorOnlyStateMigrations: undefined,
      beforeWorkspaceStateMigration: undefined,
      onStepReceipt: expect.any(Function),
    });
    expect(result.stateMigrationStepReceipts).toEqual([receipt]);
    expect(note).toHaveBeenCalledWith("- cron-imported", "Doctor changes");
    expect(note).toHaveBeenCalledWith("- imported", "Doctor changes");
  });

  it("carries cron Codex runtime policy targets only during repair", async () => {
    collectCronCodexRuntimePolicyTargetsReadOnly.mockResolvedValueOnce({
      targets: [{ modelRef: "openai/gpt-5.6-sol" }],
      warnings: [],
    });

    const result = await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      repairPrefixedConfig: true,
    });

    expect(repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      migrateCodexModelRefs: false,
    });
    expect(collectCronCodexRuntimePolicyTargetsReadOnly).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
    });
    expect(result.cronCodexRuntimePolicyTargets).toEqual([{ modelRef: "openai/gpt-5.6-sol" }]);
  });

  it("rechecks the checkpoint after acquisition before running migrations", async () => {
    readMigrationCheckpointStatus.mockReturnValueOnce("stale").mockReturnValue("startup-current");

    await runDoctorConfigPreflight(startupCheckpointOptions);

    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(readConfigFileSnapshotWithPluginMetadata).toHaveBeenCalledTimes(2);
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  registerStartupPluginConvergenceTests({
    runDoctorConfigPreflight,
    readMigrationCheckpointStatus,
    runPostCorePluginConvergence,
    runActivePluginPayloadSmokeCheck,
    recordSuccessfulStartupMigrations,
    note,
    startupEnv: () => acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env,
  });

  it("orders startup schema, host-link, state, and session repairs inside Doctor maintenance", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const migrationOrder: string[] = [];
    const beginMaintenance = beginDoctorMaintenance.getMockImplementation()!;
    beginDoctorMaintenance.mockImplementationOnce(async (params) => {
      const maintenance = (await beginMaintenance(params))!;
      const run = maintenance.run.bind(maintenance);
      maintenance.run = (operation) => {
        migrationOrder.push("maintenance");
        return run(operation);
      };
      return maintenance;
    });
    const prepareSchema = prepareLegacyStateDatabaseSchema.getMockImplementation()!;
    prepareLegacyStateDatabaseSchema.mockImplementationOnce(async (env) => {
      migrationOrder.push("schema");
      expect(startupMigrationLeaseRelease).not.toHaveBeenCalled();
      expect(doctorMaintenanceRelease).not.toHaveBeenCalled();
      return prepareSchema(env);
    });
    maybeRepairPluginOpenClawHostLinks.mockImplementationOnce(async ({ env, prompter }) => {
      migrationOrder.push("host-links");
      expect(env).not.toBe(process.env);
      expect(prompter).toEqual({ shouldRepair: true });
      return true;
    });
    autoMigrateLegacyState.mockImplementationOnce(async (params) => {
      migrationOrder.push("state");
      expect(params).toMatchObject({
        doctorOnlyStateMigrations: true,
        invocationPurpose: "startup",
      });
      return { migrated: true, skipped: false, changes: [], warnings: [] };
    });
    noteSessionTranscriptHealth.mockImplementationOnce(async (params) => {
      migrationOrder.push("sessions");
      expect(params).toMatchObject({
        shouldRepair: true,
        postSessionPluginMigrationPlanBound: true,
      });
      return undefined;
    });
    recordSuccessfulStartupMigrations.mockImplementationOnce(() => {
      migrationOrder.push("checkpoint");
      expect(doctorMaintenanceRelease).not.toHaveBeenCalled();
    });

    await runDoctorConfigPreflight(startupCheckpointOptions);

    expect(beginDoctorMaintenance).toHaveBeenCalledWith({
      options: { repair: true, nonInteractive: true },
      root: null,
      runtime: expect.any(Object),
    });
    expect(prepareDoctorDatabasePreflight).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
    });
    expect(migrationOrder).toEqual([
      "maintenance",
      "schema",
      "host-links",
      "state",
      "sessions",
      "checkpoint",
    ]);
    expect(doctorMaintenanceRelease).toHaveBeenCalledOnce();
  });

  it.each(["stale", "state-current"] as const)(
    "converges repaired plugins and migrations in one startup from a %s checkpoint",
    async (checkpoint) => {
      readMigrationCheckpointStatus.mockReturnValue(checkpoint);
      pluginMigrationFingerprint.mockReturnValue("plugin-migrations-before");
      runPostCorePluginConvergence.mockImplementationOnce(async () => {
        expect(startupMigrationLeaseHeartbeat).toHaveBeenCalled();
        expect(startupMigrationLeaseRelease).not.toHaveBeenCalled();
        pluginMigrationFingerprint.mockReturnValue("plugin-migrations-after");
        return makeStartupConvergenceResult({ changes: ["Refreshed managed plugin."] });
      });
      autoMigrateLegacyState.mockImplementationOnce(async () => {
        expect(runWithPluginMetadataSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
          configFingerprint: "plugin-migrations-after",
        });
        return { migrated: true, skipped: false, changes: [], warnings: [] };
      });
      recordSuccessfulStartupMigrations.mockImplementationOnce(() => {
        readMigrationCheckpointStatus.mockReturnValue("startup-current");
      });

      const result = await runDoctorConfigPreflight(startupCheckpointOptions);

      expect(result.pluginMetadataSnapshot?.configFingerprint).toBe("plugin-migrations-after");
      expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
      const checkpointWrite = {
        env: acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env,
        identity: expect.objectContaining({
          pluginMigrationFingerprint: "plugin-migrations-after",
        }),
        lease: startupMigrationLease,
      };
      expect(recordSuccessfulStateMigrations).toHaveBeenCalledWith(checkpointWrite);
      expect(recordSuccessfulStartupMigrations).toHaveBeenCalledWith(checkpointWrite);

      await runDoctorConfigPreflight(startupCheckpointOptions);

      expect(runPostCorePluginConvergence).toHaveBeenCalledOnce();
      expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
      expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
    },
  );

  it.each(["plugin repair", "converged config guard"] as const)(
    "refuses state migrations when the startup lease is lost during %s",
    async (lossBoundary) => {
      readMigrationCheckpointStatus.mockReturnValue("stale");
      const leaseError = new Error("Startup migration lease expired or was replaced.");
      let convergenceComplete = false;
      let leaseLost = false;
      acquireStartupMigrationLeaseWithWait.mockResolvedValueOnce({
        ...startupMigrationLease,
        heartbeat: vi.fn(() => {
          if (leaseLost) {
            throw leaseError;
          }
        }),
      });
      runPostCorePluginConvergence.mockImplementationOnce(async () => {
        convergenceComplete = true;
        leaseLost = lossBoundary === "plugin repair";
        return makeStartupConvergenceResult();
      });

      await expect(
        runDoctorConfigPreflight({
          ...startupCheckpointOptions,
          beforeStateMigrations: async () => {
            if (convergenceComplete && lossBoundary === "converged config guard") {
              leaseLost = true;
            }
            return true;
          },
        }),
      ).rejects.toMatchObject({
        code: 78,
        message: leaseError.message,
        cause: {
          code: "gateway.maintenance_required",
          kind: "state-migrations",
          cause: leaseError,
        },
      });

      expect(maybeRepairPluginOpenClawHostLinks).not.toHaveBeenCalled();
      expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
      expect(autoMigrateLegacyState).not.toHaveBeenCalled();
      expect(autoMigrateLegacyPluginDoctorState).not.toHaveBeenCalled();
      expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
      expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
      expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
    },
  );

  it("rejects external config changes during plugin repair before state migrations", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    runPostCorePluginConvergence.mockImplementationOnce(async () => {
      queueConfigSnapshot(
        readConfigFileSnapshot,
        makePreflightConfigSnapshot({ gateway: { mode: "local", port: 19092 } }),
      );
      return makeStartupConvergenceResult();
    });

    await expect(runDoctorConfigPreflight(startupCheckpointOptions)).rejects.toThrow(
      "migration inputs changed during startup (resolved config values changed)",
    );

    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("refuses startup when plugin migration inputs change after state migration", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    pluginMigrationFingerprint.mockImplementation(() =>
      autoMigrateLegacyState.mock.calls.length > 0
        ? "plugin-migrations-after"
        : "plugin-migrations-before",
    );

    await expect(runDoctorConfigPreflight(startupCheckpointOptions)).rejects.toThrow(
      "migration inputs changed during startup",
    );

    expect(recordSuccessfulStateMigrations).toHaveBeenCalledWith({
      env: acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env,
      identity: expect.objectContaining({
        pluginMigrationFingerprint: "plugin-migrations-before",
      }),
      lease: startupMigrationLease,
    });
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("records the authoritative startup checkpoint after notices and runtime replacement", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    pluginMigrationFingerprint.mockImplementation((allowCurrentPluginMetadata) =>
      runPostCorePluginConvergence.mock.calls.length > 0 && allowCurrentPluginMetadata !== false
        ? "plugin-migrations-runtime-current"
        : "plugin-migrations",
    );
    autoMigrateLegacyStateDir.mockResolvedValueOnce({
      migrated: true,
      skipped: false,
      changes: [],
      warnings: [],
      notices: ["Left reviewed residue in place."],
    });

    await runDoctorConfigPreflight(startupCheckpointOptions);

    const pinnedEnv = acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env;
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledWith({
      env: pinnedEnv,
      identity: expectMigrationIdentity(),
      lease: startupMigrationLease,
    });
    expect(note).toHaveBeenCalledWith("- Left reviewed residue in place.", "Doctor notices");
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("checkpoints after a dreaming conflict is archived without a migration warning", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    autoMigrateLegacyPluginDoctorState.mockResolvedValueOnce({
      migrated: true,
      skipped: false,
      changes: [
        "Resolved Memory Core session ingestion legacy conflict by keeping canonical SQLite plugin state",
        "Archived Memory Core session ingestion conflicting legacy source",
      ],
      warnings: [],
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      skipPristineCoreStateMigrations: true,
    });

    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Resolved Memory Core session ingestion legacy conflict by keeping canonical SQLite plugin state",
      ),
      "Doctor changes",
    );
    expect(note).not.toHaveBeenCalledWith(
      expect.stringContaining("SQLite rows conflict with the legacy source"),
      "Doctor warnings",
    );
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledOnce();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("clears stale plugin quarantine through the current-checkpoint preflight", async () => {
    setActiveDegradedPlugins([
      {
        pluginId: "stale-plugin",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-main-entry",
          detail: "index.js",
          installPath: "/plugins/stale-plugin",
        },
      },
    ]);
    planStartupPluginConvergence.mockResolvedValueOnce({ required: false, installRecords: {} });

    await runDoctorConfigPreflight(startupCheckpointOptions);

    expect(listActiveDegradedPlugins()).toEqual([]);
    expect(runActivePluginPayloadSmokeCheck).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "starts degraded with a missing plugin (host-link warning=%s)",
    async (hostLinkWarning) => {
      readMigrationCheckpointStatus.mockReturnValue("stale");
      const snapshot = makePreflightConfigSnapshot({
        gateway: { mode: "local", port: 19091 },
        plugins: { entries: { discord: { enabled: true } } },
      });
      runPostCorePluginConvergence.mockResolvedValueOnce(
        makeStartupConvergenceResult({
          errored: true,
          warnings: [
            ...(hostLinkWarning
              ? [
                  {
                    reason: "Failed to repair installed OpenClaw host peer links: EACCES",
                    message: "Failed to repair installed OpenClaw host peer links: EACCES",
                    guidance: ["Run `openclaw doctor --fix` to retry plugin repair."],
                  },
                ]
              : []),
            {
              pluginId: "discord",
              reason: "missing-install-path: install path missing",
              message: 'Plugin "discord" has no install path.',
              guidance: ["Run `openclaw update repair` to retry plugin repair."],
            },
          ],
          smokeFailures: [
            {
              pluginId: "discord",
              reason: "missing-install-path",
              detail: "install path missing",
            },
          ],
        }),
      );

      await readConfigFileSnapshot.withImplementation(
        async () => snapshot,
        async () => {
          const result = await runDoctorConfigPreflight(startupCheckpointOptions);
          expect(result.stateMigrationStepReceipts).toContainEqual(
            expect.objectContaining({
              id: "plugin:discord",
              outcome: "deferred",
              warnings: [expect.stringContaining('Run "openclaw update repair"')],
            }),
          );
        },
      );

      expect(recordDeferredPluginMigrations).toHaveBeenCalledWith({
        env: acquireStartupMigrationLeaseWithWait.mock.calls[0]?.[0]?.env,
        pending: [expect.objectContaining({ pluginId: "discord" })],
        expectedPending: [],
      });
      expect(listActiveDegradedPlugins()).toMatchObject([
        {
          pluginId: "discord",
          state: "configured-unavailable",
          diagnostic: { reason: "missing-install-path" },
        },
      ]);
      expect(readStartupMigrationWarning()).toContain('Plugin "discord"');
      if (hostLinkWarning) {
        expect(readStartupMigrationWarning()).toContain(
          "Failed to repair installed OpenClaw host peer links: EACCES",
        );
      }
      expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    },
  );

  it("preserves verified plugin quarantine while an older writable parent defers repair", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const snapshot = makePreflightConfigSnapshot({
      gateway: { mode: "local", port: 19091 },
      plugins: { entries: { discord: { enabled: true } } },
    });
    const quarantined: DegradedPlugin = {
      pluginId: "discord",
      state: "configured-unavailable",
      diagnostic: {
        kind: "plugin-verification",
        reason: "missing-package-json",
        detail: "package.json is missing",
        installPath: "/plugins/discord",
      },
    };
    setActiveDegradedPlugins([quarantined]);
    planStartupPluginConvergence.mockResolvedValueOnce({
      required: true,
      installRecords: { discord: { source: "npm", installPath: "/plugins/discord" } },
    });
    runActivePluginPayloadSmokeCheck.mockResolvedValueOnce({
      checked: ["discord"],
      failures: makeQuarantinedPluginRepairConvergence("discord", "discord").smokeFailures,
    });

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
      },
      () =>
        readConfigFileSnapshot.withImplementation(
          async () => snapshot,
          async () => {
            const result = await runDoctorConfigPreflight(startupCheckpointOptions);
            expect(result.stateMigrationStepReceipts).toContainEqual(
              expect.objectContaining({
                id: "plugin:discord",
                outcome: "deferred",
                warnings: [
                  expect.stringContaining(
                    'Let the current update or repair finish. If this warning remains afterward, run "openclaw update repair"',
                  ),
                ],
              }),
            );
          },
        ),
    );

    expect(runActivePluginPayloadSmokeCheck).toHaveBeenCalledOnce();
    expect(runPostCorePluginConvergence).not.toHaveBeenCalled();
    expect(listActiveDegradedPlugins()).toEqual([quarantined]);
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
  });

  it("checkpoints startup migrations without loading plugin convergence when the plan is empty", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    planStartupPluginConvergence.mockResolvedValueOnce({ required: false, installRecords: {} });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(planStartupPluginConvergence).toHaveBeenCalledWith({
      config: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
    });
    expect(runPostCorePluginConvergence).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledOnce();
  });

  it("skips legacy migration loading for a prepared pristine state root", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    planStartupPluginConvergence.mockResolvedValueOnce({ required: false, installRecords: {} });
    const beforeStateMigrations = vi.fn(async () => true);

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      skipPristineStartupStateMigrations: true,
      beforeStateMigrations,
    });

    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(beforeStateMigrations).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ valid: true }),
    );
    expect(recordSuccessfulStartupMigrations).toHaveBeenCalledOnce();
  });

  it("runs only plugin-owned migrations for a pristine core state root", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    planPristineStartupStateMigrations.mockReturnValueOnce({
      skipAllStateMigrations: false,
      skipCoreStateMigrations: true,
    });

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(autoMigrateLegacyStateDir).toHaveBeenCalledOnce();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledWith({
      config: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      log: expect.any(Object),
      doctorOnlyStateMigrations: true,
    });
  });

  it("retains the prepared core-state fact and explicit Doctor repair authority", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");

    await runDoctorConfigPreflight({
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      requireStartupMigrationCheckpoint: true,
      skipPristineCoreStateMigrations: true,
      doctorOnlyStateMigrations: true,
    });

    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).toHaveBeenCalledWith({
      config: { gateway: { mode: "local", port: 19091 } },
      env: process.env,
      log: expect.any(Object),
      doctorOnlyStateMigrations: true,
    });
  });
});
