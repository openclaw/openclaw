import { beforeEach, describe, expect, it } from "vitest";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import { listActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import {
  preflightStateMigrationMocks,
  resetStateMigrationPreflightMocks,
} from "./doctor-config-preflight.state-migration.test-harness.js";
import {
  makePreflightConfigSnapshot,
  makeQuarantinedPluginRepairConvergence,
  startupCheckpointOptions,
} from "./doctor-config-preflight.state-migration.test-helpers.js";

const {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyState,
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyTaskStateSidecars,
  repairLegacyCronStoreWithoutPrompt,
  readMigrationCheckpointStatus,
  startupMigrationLeaseRelease,
  acquireStartupMigrationLeaseWithWait,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
  runPostCorePluginConvergence,
  readConfigFileSnapshot,
  note,
} = preflightStateMigrationMocks;
const { runDoctorConfigPreflight } = await import("./doctor-config-preflight.js");

describe("runDoctorConfigPreflight state migration startup outcomes", () => {
  beforeEach(resetStateMigrationPreflightMocks);

  it("allows warning-only startup without certifying completion", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    autoMigrateLegacyStateDir.mockResolvedValueOnce({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: ["Left legacy config health state in place."],
    });

    await expect(runDoctorConfigPreflight(startupCheckpointOptions)).resolves.toBeDefined();

    expect(readStartupMigrationWarning()).toContain("Left legacy config health state in place.");
    expect(readStartupMigrationWarning()).toContain(
      'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
    );
    expect(note.mock.calls.filter(([, title]) => title === "Doctor warnings")).toHaveLength(0);
    expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
    await runDoctorConfigPreflight(startupCheckpointOptions);
    expect(readStartupMigrationWarning()).toContain("Left legacy config health state in place.");
  });

  it("bounds and redacts startup warnings while preserving the Doctor follow-up", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const credential = "sk-" + "syntheticfixture".repeat(4);
    autoMigrateLegacyStateDir.mockResolvedValueOnce({
      migrated: false,
      skipped: false,
      changes: [],
      warnings: [`Detector token ${credential} ${"details ".repeat(1000)}`],
    });
    await runDoctorConfigPreflight(startupCheckpointOptions);
    const warning = readStartupMigrationWarning();
    expect(warning).not.toContain(credential);
    expect(warning?.length).toBeLessThan(2200);
    expect(warning).toContain("… (see startup log)");
    expect(warning).toContain(
      'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
    );
  });

  it("refuses startup and releases the lease when a migration errors", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    autoMigrateLegacyState.mockRejectedValueOnce(new Error("Canonical state cannot be read"));

    await expect(runDoctorConfigPreflight(startupCheckpointOptions)).rejects.toThrow(
      "Canonical state cannot be read",
    );
    expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it.each([undefined, "discord"])(
    "records plugin repair warnings without blocking startup (plugin=%s)",
    async (pluginId) => {
      readMigrationCheckpointStatus.mockReturnValue("stale");
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
          const result = await runDoctorConfigPreflight(startupCheckpointOptions);
          if (pluginId) {
            expect(result.stateMigrationStepReceipts).toContainEqual(
              expect.objectContaining({ id: `plugin:${pluginId}`, outcome: "deferred" }),
            );
          }
          expect(autoMigrateLegacyState).toHaveBeenCalledOnce();
          expect(readStartupMigrationWarning()).toContain("npm package not found");
        },
      );

      expect(listActiveDegradedPlugins()).toEqual([
        expect.objectContaining({ pluginId: "slack", state: "configured-unavailable" }),
      ]);
      expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
      expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("npm package not found"),
        "Doctor warnings",
      );
      expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
    },
  );

  it("keeps an unavailable repair nonblocking for its quarantined plugin", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const snapshot = makePreflightConfigSnapshot({
      gateway: { mode: "local", port: 19091 },
      plugins: { entries: { discord: { enabled: true } } },
    });
    runPostCorePluginConvergence.mockResolvedValueOnce(
      makeQuarantinedPluginRepairConvergence("discord", "discord"),
    );

    await readConfigFileSnapshot.withImplementation(
      async () => snapshot,
      () => runDoctorConfigPreflight(startupCheckpointOptions),
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
    expect(note.mock.calls.filter(([, title]) => title === "Doctor warnings")).toHaveLength(1);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update discord: npm package not found."),
      "Doctor warnings",
    );
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).toHaveBeenCalledOnce();
  });

  it("refuses invalid config before acquiring the startup lease or running migrations", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const snapshot = {
      ...makePreflightConfigSnapshot({ gateway: { mode: "local", port: "bad" } }),
      valid: false,
      issues: [{ path: "gateway.port", message: "invalid" }],
    };
    await readConfigFileSnapshot.withImplementation(
      async () => snapshot,
      () =>
        expect(runDoctorConfigPreflight(startupCheckpointOptions)).rejects.toThrow(
          "OpenClaw config is invalid",
        ),
    );

    expect(acquireStartupMigrationLeaseWithWait).not.toHaveBeenCalled();
    expect(autoMigrateLegacyStateDir).not.toHaveBeenCalled();
    expect(repairLegacyCronStoreWithoutPrompt).not.toHaveBeenCalled();
    expect(autoMigrateLegacyState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyPluginDoctorState).not.toHaveBeenCalled();
    expect(autoMigrateLegacyTaskStateSidecars).not.toHaveBeenCalled();
    expect(recordSuccessfulStateMigrations).not.toHaveBeenCalled();
    expect(recordSuccessfulStartupMigrations).not.toHaveBeenCalled();
    expect(startupMigrationLeaseRelease).not.toHaveBeenCalled();
  });
});
