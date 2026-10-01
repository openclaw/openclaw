// Doctor migration ordering, metadata ownership, and repair failure behavior.
import { beforeEach, describe, expect, it } from "vitest";
import {
  readStartupMigrationWarning,
  recordStartupMigrationWarnings,
} from "../infra/state-migrations.messages.js";
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
  recordDeferredPluginMigrations,
  pluginMigrationFingerprint,
  runWithPluginMetadataSnapshot,
  note,
} = preflightStateMigrationMocks;
const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");
const doctorMigrationOptions = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  preparePluginMetadataSnapshot: true,
} as const;

describe("runDoctorConfigPreflight state migration", () => {
  beforeEach(resetStateMigrationPreflightMocks);

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
      failures: [
        {
          pluginId: "discord",
          installPath: "/plugins/discord",
          reason: "missing-package-json",
          detail: "package.json is missing",
        },
      ],
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

  it("keeps missing plugins deferred and reports host-link repair warnings", async () => {
    const hostWarning = "Failed to repair installed OpenClaw host peer links: EACCES";
    const snapshot = makePreflightConfigSnapshot({
      gateway: { mode: "local", port: 19091 },
      plugins: { entries: { discord: { enabled: true } } },
    });
    runPostCorePluginConvergence.mockResolvedValueOnce(
      makeStartupConvergenceResult({
        errored: true,
        warnings: [
          {
            reason: hostWarning,
            message: hostWarning,
            guidance: ["Run `openclaw doctor --fix` to retry plugin repair."],
          },
          {
            pluginId: "discord",
            reason: "missing-install-path: install path missing",
            message: 'Plugin "discord" has no install path.',
            guidance: ["Run `openclaw update repair` to retry plugin repair."],
          },
        ],
        smokeFailures: [
          { pluginId: "discord", reason: "missing-install-path", detail: "install path missing" },
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
    expect(note).toHaveBeenCalledWith(expect.stringContaining(hostWarning), "Doctor warnings");
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
    await expect(runDoctorConfigPreflight(doctorMigrationOptions)).resolves.toMatchObject({
      stateMigrationMessages: expect.arrayContaining([
        expect.objectContaining({
          stepId: "state-directory",
          result: expect.objectContaining({
            changes: [],
            warnings: ["Left legacy config health state in place."],
          }),
        }),
      ]),
    });
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
