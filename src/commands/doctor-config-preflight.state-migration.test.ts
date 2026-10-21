import { beforeEach, expect, it } from "vitest";
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
  preflightStateMigrationMocks as mocks,
  resetStateMigrationPreflightMocks,
} from "./doctor-config-preflight.state-migration.test-harness.js";
import {
  makePreflightConfigSnapshot,
  makeStartupConvergenceResult,
} from "./doctor-config-preflight.state-migration.test-helpers.js";

const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");
const doctorMigrationOptions = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  preparePluginMetadataSnapshot: true,
} as const;
const gateway = { mode: "local", port: 19091 } as const;
type PreflightResult = Awaited<ReturnType<typeof runDoctorConfigPreflight>>;
function withPluginConfig(check: (result: PreflightResult) => void) {
  const snapshot = makePreflightConfigSnapshot({
    gateway,
    plugins: { entries: { discord: { enabled: true } } },
  });
  return mocks.readConfigFileSnapshot.withImplementation(
    async () => snapshot,
    async () => check(await runDoctorConfigPreflight(doctorMigrationOptions)),
  );
}
function expectDeferredPlugin(result: PreflightResult, warning: string) {
  expect(result.stateMigrationStepReceipts).toContainEqual(
    expect.objectContaining({
      id: "plugin:discord",
      outcome: "deferred",
      warnings: [expect.stringContaining(warning)],
    }),
  );
}

beforeEach(resetStateMigrationPreflightMocks);

it("carries cron Codex runtime policy targets only during repair", async () => {
  mocks.collectCronCodexRuntimePolicyTargetsReadOnly.mockResolvedValueOnce({
    targets: [{ modelRef: "openai/gpt-5.6-sol" }],
    warnings: [],
  });

  const result = await runDoctorConfigPreflight({
    migrateLegacyConfig: false,
    invalidConfigNote: false,
    repairPrefixedConfig: true,
  });

  expect(mocks.repairLegacyCronStoreWithoutPrompt).toHaveBeenCalledWith({
    cfg: { gateway },
    migrateCodexModelRefs: false,
  });
  expect(mocks.collectCronCodexRuntimePolicyTargetsReadOnly).toHaveBeenCalledWith({
    cfg: { gateway },
  });
  expect(result.cronCodexRuntimePolicyTargets).toEqual([{ modelRef: "openai/gpt-5.6-sol" }]);
});

it("preserves verified plugin quarantine while an older writable parent defers repair", async () => {
  const failure = {
    installPath: "/plugins/discord",
    reason: "missing-package-json",
    detail: "package.json is missing",
  } as const;
  const quarantined: DegradedPlugin = {
    pluginId: "discord",
    state: "configured-unavailable",
    diagnostic: {
      kind: "plugin-verification",
      ...failure,
    },
  };
  setActiveDegradedPlugins([quarantined]);
  mocks.runActivePluginPayloadSmokeCheck.mockResolvedValueOnce({
    checked: ["discord"],
    failures: [{ pluginId: "discord", ...failure }],
  });

  await withEnvAsync(
    {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
    },
    () =>
      withPluginConfig((result) => {
        expectDeferredPlugin(
          result,
          'Let the current update or repair finish. If this warning remains afterward, run "openclaw update repair"',
        );
      }),
  );

  expect(mocks.runActivePluginPayloadSmokeCheck).toHaveBeenCalledOnce();
  expect(mocks.runPostCorePluginConvergence).not.toHaveBeenCalled();
  expect(listActiveDegradedPlugins()).toEqual([quarantined]);
});

it("keeps missing plugins deferred and reports host-link repair warnings", async () => {
  const hostWarning = "Failed to repair installed OpenClaw host peer links: EACCES";
  mocks.runPostCorePluginConvergence.mockResolvedValueOnce(
    makeStartupConvergenceResult({
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
  await withPluginConfig((result) => {
    expect(result.warnings).toContain(
      `${hostWarning} Run \`openclaw doctor --fix\` to retry plugin repair.`,
    );
    expectDeferredPlugin(result, 'Run "openclaw update repair"');
  });
  expect(mocks.recordDeferredPluginMigrations).toHaveBeenCalledWith({
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
  for (const message of ['Plugin "discord"', hostWarning]) {
    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining(message), "Doctor warnings");
  }
});

it("bounds and redacts recorded migration warnings while preserving Doctor guidance", () => {
  const credential = "sk-" + "syntheticfixture".repeat(4);
  recordStartupMigrationWarnings([`Detector token ${credential} ${"details ".repeat(1000)}`]);
  const warning = readStartupMigrationWarning();
  expect(warning).not.toContain(credential);
  expect(warning?.length).toBeLessThan(2200);
  expect(warning).toContain("… (see startup log)");
  expect(warning).toContain(
    'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
  );
});
