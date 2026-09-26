// Doctor migration ordering, metadata ownership, and repair failure behavior.
import { beforeEach, describe, expect, it } from "vitest";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import {
  readStartupMigrationWarning,
  recordStartupMigrationWarnings,
} from "../infra/state-migrations.messages.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
  type DegradedPlugin,
} from "../plugins/runtime-degraded-state.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  preflightStateMigrationMocks,
  resetStateMigrationPreflightMocks,
} from "./doctor-config-preflight.state-migration.test-harness.js";
import {
  makePreflightConfigSnapshot,
  makeStartupConvergenceResult,
  makeQuarantinedPluginRepairConvergence,
  queueConfigSnapshot,
} from "./doctor-config-preflight.state-migration.test-helpers.js";

const {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyState,
  repairLegacyCronStoreWithoutPrompt,
  collectCronCodexRuntimePolicyTargetsReadOnly,
  runPostCorePluginConvergence,
  runActivePluginPayloadSmokeCheck,
  planStartupPluginConvergence,
  readConfigFileSnapshot,
  pluginMigrationFingerprint,
  runWithPluginMetadataSnapshot,
  note,
  recordDeferredPluginMigrations,
} = preflightStateMigrationMocks;
const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");
const doctorMigrationOptions = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  preparePluginMetadataSnapshot: true,
} as const;

describe("runDoctorConfigPreflight state migration", () => {
  beforeEach(resetStateMigrationPreflightMocks);

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
      recoverCorruptTargetStore: undefined,
      doctorOnlyStateMigrations: undefined,
      invocationPurpose: undefined,
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

  it("rejects external config changes during plugin repair before state migrations", async () => {
    runPostCorePluginConvergence.mockImplementationOnce(async () => {
      queueConfigSnapshot(
        readConfigFileSnapshot,
        makePreflightConfigSnapshot({ gateway: { mode: "local", port: 19092 } }),
      );
      return makeStartupConvergenceResult();
    });

    await expect(runDoctorConfigPreflight(doctorMigrationOptions)).rejects.toThrow(
      "migration inputs changed during startup",
    );

    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
  });

  it("clears stale plugin quarantine when Doctor verifies the current inventory", async () => {
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

    await runDoctorConfigPreflight(doctorMigrationOptions);

    expect(listActiveDegradedPlugins()).toEqual([]);
    expect(runActivePluginPayloadSmokeCheck).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps Doctor degraded with a missing plugin (host-link warning=%s)",
    async (hostLinkWarning) => {
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
          const result = await runDoctorConfigPreflight(doctorMigrationOptions);
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
        env: process.env,
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
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining('Plugin "discord"'),
        "Doctor warnings",
      );
      if (hostLinkWarning) {
        expect(note).toHaveBeenCalledWith(
          expect.stringContaining("Failed to repair installed OpenClaw host peer links: EACCES"),
          "Doctor warnings",
        );
      }
    },
  );

  it("preserves verified plugin quarantine while an older writable parent defers repair", async () => {
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
            const result = await runDoctorConfigPreflight(doctorMigrationOptions);
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
  });

  it("propagates failed migrations from Doctor", async () => {
    autoMigrateLegacyState.mockRejectedValueOnce(new Error("Canonical state cannot be read"));

    await expect(runDoctorConfigPreflight(doctorMigrationOptions)).rejects.toThrow(
      "Canonical state cannot be read",
    );
  });

  it.each([undefined, "discord"])(
    "reports plugin repair warnings without blocking Doctor (plugin=%s)",
    async (pluginId) => {
      const snapshot = makePreflightConfigSnapshot({
        gateway: { mode: "local", port: 19091 },
        plugins: { entries: { slack: { enabled: true } } },
      });
      runPostCorePluginConvergence.mockResolvedValueOnce(
        makeQuarantinedPluginRepairConvergence("slack", pluginId),
      );

      await readConfigFileSnapshot.withImplementation(
        async () => snapshot,
        async () => {
          const result = await runDoctorConfigPreflight(doctorMigrationOptions);
          if (pluginId) {
            expect(result.stateMigrationStepReceipts).toContainEqual(
              expect.objectContaining({ id: `plugin:${pluginId}`, outcome: "deferred" }),
            );
          }
          expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
        },
      );

      expect(listActiveDegradedPlugins()).toEqual([
        expect.objectContaining({ pluginId: "slack", state: "configured-unavailable" }),
      ]);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("npm package not found"),
        "Doctor warnings",
      );
    },
  );

  it("keeps an unavailable repair nonblocking for its quarantined plugin", async () => {
    const snapshot = makePreflightConfigSnapshot({
      gateway: { mode: "local", port: 19091 },
      plugins: { entries: { discord: { enabled: true } } },
    });
    runPostCorePluginConvergence.mockResolvedValueOnce(
      makeQuarantinedPluginRepairConvergence("discord", "discord"),
    );

    await readConfigFileSnapshot.withImplementation(
      async () => snapshot,
      () => runDoctorConfigPreflight(doctorMigrationOptions),
    );

    expect(listActiveDegradedPlugins()).toEqual([
      {
        pluginId: "discord",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-package-json",
          detail: "package.json is missing",
          installPath: "/plugins/discord",
        },
      },
    ]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        '- Plugin "discord" failed post-core payload smoke check (missing): package.json is missing',
      ),
      "Doctor warnings",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update discord: npm package not found."),
      "Doctor warnings",
    );
  });

  it("uses the converged plugin generation for Doctor state migrations", async () => {
    pluginMigrationFingerprint.mockReturnValue("plugin-migrations-before");
    runPostCorePluginConvergence.mockImplementationOnce(async () => {
      pluginMigrationFingerprint.mockReturnValue("plugin-migrations-after");
      return makeStartupConvergenceResult({ changes: ["Refreshed managed plugin."] });
    });
    autoMigrateLegacyState.mockImplementationOnce(async () => {
      expect(runWithPluginMetadataSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({
        configFingerprint: "plugin-migrations-after",
      });
      return { migrated: true, skipped: false, changes: [], warnings: [] };
    });
    const result = await runDoctorConfigPreflight(doctorMigrationOptions);
    expect(result.pluginMetadataSnapshot?.configFingerprint).toBe("plugin-migrations-after");
    expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
  });

  it("reports advisory migration warnings without blocking Doctor", async () => {
    autoMigrateLegacyStateDir.mockResolvedValueOnce({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: ["Left legacy config health state in place."],
    });
    await expect(runDoctorConfigPreflight(doctorMigrationOptions)).resolves.toBeDefined();
    expect(note).toHaveBeenCalledWith(
      "- Left legacy config health state in place.",
      "Doctor warnings",
    );
  });

  it("bounds and redacts recorded migration warnings while preserving Doctor guidance", () => {
    const credential = "sk-" + "syntheticfixture".repeat(4);
    try {
      recordStartupMigrationWarnings([`Detector token ${credential} ${"details ".repeat(1000)}`]);
      const warning = readStartupMigrationWarning();
      expect(warning).not.toContain(credential);
      expect(warning?.length).toBeLessThan(2200);
      expect(warning).toContain("… (see startup log)");
      expect(warning).toContain(
        'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
      );
    } finally {
      recordStartupMigrationWarnings([]);
    }
  });
});
