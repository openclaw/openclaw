import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
  createTestInstalledPluginIndex,
  setInstalledPluginIndexInstallRecords,
  runPluginsCommand,
  configWriteMock,
  pluginsCliRuntimeLogs,
  runtimeErrors,
  updateNpmInstalledPluginsMock,
  updateNpmInstalledHookPacksMock,
} from "./plugins-cli-test-helpers.js";

export function expectInstallRecordsWrittenWithLease(records: unknown, config: unknown) {
  expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

export function writtenIndexCustody() {
  const options =
    writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls.at(-1)?.[1];
  if (!options) {
    throw new Error("expected an index write before registry refresh");
  }
  return {
    filePath: options.filePath,
    lease: {
      ...options.lease,
      // Refresh wraps the guards while retaining the original lease owner and signal.
      assertOwned: expect.any(Function),
      assertOwnedInTransaction: expect.any(Function),
    },
  };
}

/** Shares the update suite's reset, config lease and Nix-environment restoration. */
export function registerRuntimeMaintenanceUpdateTests({
  runtimeMaintenance,
  primeUpdateConfigSnapshot,
  primePluginUpdate,
}: {
  runtimeMaintenance: Mock;
  primeUpdateConfigSnapshot: (params: { config: OpenClawConfig }) => unknown;
  primePluginUpdate: (
    config: OpenClawConfig,
    outcomes: Awaited<ReturnType<typeof updateNpmInstalledPluginsMock>>["outcomes"],
  ) => void;
}) {
  it.each([false, true])(
    "maintains an unchanged selected runtime unless dry-run=%s",
    async (dryRun) => {
      primeUpdateConfigSnapshot({ config: {} });
      setInstalledPluginIndexInstallRecords({
        alpha: { source: "npm", spec: "@acme/alpha", installPath: "/tmp/alpha" },
      });
      primePluginUpdate({}, [{ pluginId: "alpha", status: "unchanged", message: "Current." }]);
      runtimeMaintenance.mockResolvedValue([
        "Retained working runtime; candidate was incompatible.",
      ]);
      await runPluginsCommand(["plugins", "update", "alpha", ...(dryRun ? ["--dry-run"] : [])]);
      if (dryRun) {
        expect(runtimeMaintenance).not.toHaveBeenCalled();
      } else {
        expect(runtimeMaintenance).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            operation: "update",
            pluginIds: ["alpha"],
            assertCurrent: expect.any(Function),
          }),
        );
        expect(pluginsCliRuntimeLogs.join("\n")).toContain("candidate was incompatible");
      }
      expect(configWriteMock).not.toHaveBeenCalled();
    },
  );

  it("maintains the committed migrated runtime settings while preserving authored env refs", async () => {
    const before: OpenClawConfig = {
      plugins: { entries: { alpha: { enabled: true, config: { command: "old" } } } },
    };
    const migrated: OpenClawConfig = {
      plugins: {
        entries: { alpha: { enabled: true, config: { command: "${PR157920_RUNTIME}" } } },
      },
    };
    primeUpdateConfigSnapshot({ config: before });
    setInstalledPluginIndexInstallRecords({
      alpha: { source: "npm", spec: "@acme/alpha", installPath: "/tmp/alpha" },
    });
    primePluginUpdate(before, [{ pluginId: "alpha", status: "unchanged", message: "Current." }]);
    const migrationModule =
      await import("../commands/doctor/shared/plugin-update-config-migration.js");
    const migration = vi
      .spyOn(migrationModule, "preparePluginUpdateConfigMigration")
      .mockResolvedValue({
        config: migrated,
        changed: true,
        async [Symbol.asyncDispose]() {},
        async publish(_config, commit) {
          return await commit();
        },
      });
    const previous = process.env.PR157920_RUNTIME;
    process.env.PR157920_RUNTIME = "/new/selected/codex";
    try {
      await runPluginsCommand(["plugins", "update", "alpha"]);
      expect(runtimeErrors).toEqual([]);
      expect(configWriteMock).toHaveBeenCalledWith(migrated);
      expect(runtimeMaintenance).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          config: {
            plugins: {
              entries: { alpha: { enabled: true, config: { command: "/new/selected/codex" } } },
            },
          },
        }),
      );
    } finally {
      migration.mockRestore();
      if (previous === undefined) {
        delete process.env.PR157920_RUNTIME;
      } else {
        process.env.PR157920_RUNTIME = previous;
      }
    }
  });

  it.each([false, true])(
    "routes an enabled bundled codex runtime without package ownership (dry-run=%s)",
    async (dryRun) => {
      primeUpdateConfigSnapshot({ config: { plugins: { entries: { codex: { enabled: true } } } } });
      const indexModule = await import("../plugins/installed-plugin-index.js");
      const index = vi.spyOn(indexModule, "loadInstalledPluginIndex").mockReturnValue(
        createTestInstalledPluginIndex({
          policyHash: "bundled-runtime",
          installRecords: {},
          plugins: [
            {
              pluginId: "codex",
              origin: "bundled",
              enabled: true,
              rootDir: "/bundled/codex",
              manifestPath: "/bundled/codex/openclaw.plugin.json",
              manifestHash: "synthetic",
              startup: { sidecar: false, memory: false, agentHarnesses: ["codex"] },
              compat: [],
            },
          ],
        }),
      );
      try {
        await runPluginsCommand(["plugins", "update", "codex", ...(dryRun ? ["--dry-run"] : [])]);
        expect(runtimeErrors).toEqual([]);
        expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
        expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
        expect(configWriteMock).not.toHaveBeenCalled();
        expect(
          writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
        ).not.toHaveBeenCalled();
        if (dryRun) {
          expect(runtimeMaintenance).not.toHaveBeenCalled();
          expect(pluginsCliRuntimeLogs.join("\n")).toContain(
            'managed runtime for bundled plugin "codex"',
          );
        } else {
          expect(runtimeMaintenance).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ pluginIds: ["codex"], operation: "update" }),
          );
        }
      } finally {
        index.mockRestore();
      }
    },
  );

  it("refuses plugin updates in Nix mode before package-manager work", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow(
      "OPENCLAW_NIX_MODE=1",
    );

    expect(updateNpmInstalledPluginsMock).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacksMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });
}

export function expectOfflineNoticeLogged() {
  expect(pluginsCliRuntimeLogs).toContain(
    "Updates saved; they will load on the next Gateway start.",
  );
}
