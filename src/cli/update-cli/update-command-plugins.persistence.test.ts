import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverInstalledPluginConfigIds } from "../../commands/doctor/shared/installed-plugin-id-recovery.js";
import { seedRecoveryOwner } from "../../commands/doctor/shared/installed-plugin-id-recovery.test-support.js";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../../config/config.js";
import { setRuntimeConfigSnapshotRefreshHandler } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({ convergence: vi.fn() }));
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: mocks.convergence,
}));
import { preparePostCorePluginConfig } from "./update-command-config.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

afterEach(() => {
  vi.restoreAllMocks();
  mocks.convergence.mockClear();
  setRuntimeConfigSnapshotRefreshHandler(null);
});

async function prepareUpdate(state: OpenClawTestState, config: OpenClawConfig) {
  // Config-write custody uses a host control store outside the profile database.
  const control = state.path("control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  await state.writeConfig(config);
  await seedInstalledPluginIndex({}, { config, env: state.env });
  return {
    root: state.root,
    channel: "stable" as const,
    configSnapshot: await readConfigFileSnapshot(),
    configChanged: true,
    pluginInstallRecords: {},
    timeoutMs: 1_000,
    json: true,
  };
}

function convergenceResult(config: OpenClawConfig) {
  return {
    config,
    configChanges: [],
    installedPluginIdRecovery: new Map(),
    changes: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: { fixture: { source: "archive" as const } },
  };
}

describe("plugin final publication config rebase", () => {
  it.each([
    "unrelated",
    "already-applied",
    "already-deleted",
    "owned-conflict",
    "parent-shape",
    "include",
  ])("preserves a concurrent %s edit through final publication", async (change) => {
    await withOpenClawTestState({ label: `plugin-rebase-${change}` }, async (state) => {
      const config: OpenClawConfig = {
        plugins: { enabled: false, entries: { fixture: { enabled: true } } },
        gateway: { port: 18789 },
      };
      const prepared = await prepareUpdate(state, config);
      if (change === "include") {
        await fs.writeFile(state.statePath("plugins.json"), JSON.stringify(config.plugins));
        await state.writeConfig({ ...config, plugins: { $include: "./plugins.json" } });
        prepared.configSnapshot = await readConfigFileSnapshot();
      }
      const write = await readConfigFileSnapshotForWrite();
      mocks.convergence.mockImplementationOnce(async ({ cfg }) => {
        const plugins =
          change === "parent-shape" || change === "already-deleted"
            ? { enabled: false }
            : {
                ...config.plugins,
                entries: {
                  fixture: {
                    enabled: change !== "already-applied" && change !== "owned-conflict",
                  },
                },
              };
        if (change === "include") {
          await fs.writeFile(
            state.statePath("plugins.json"),
            JSON.stringify({ ...plugins, allow: ["fixture"] }),
          );
        } else {
          await state.writeConfig({ ...config, plugins, gateway: { port: 19001 } });
        }
        return convergenceResult({
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries:
              change === "owned-conflict" || change === "already-deleted"
                ? {}
                : { fixture: { enabled: false } },
          },
        });
      });
      const update = updatePluginsAfterCoreUpdate({
        ...prepared,
        configWriteOptions: write.writeOptions,
      });
      const conflict = change === "owned-conflict" || change === "parent-shape";
      if (conflict) {
        await expect(update).rejects.toThrow("Plugin finalization conflicts");
      } else {
        await expect(update).resolves.toMatchObject({ status: "ok" });
      }
      const saved = (await readConfigFileSnapshot()).sourceConfig;
      expect(saved.gateway?.port).toBe(change === "include" ? 18789 : 19001);
      expect(saved.plugins?.entries?.fixture?.enabled).toBe(
        change === "parent-shape" || change === "already-deleted" ? undefined : false,
      );
      if (change === "include") {
        expect(saved.plugins?.allow).toEqual(["fixture"]);
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8")).plugins).toEqual({
          $include: "./plugins.json",
        });
      }
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual(conflict ? {} : { fixture: { source: "archive" } });
      expect(mocks.convergence).toHaveBeenCalledTimes(1);
    });
  });

  it.each([1, 5])("refreshes include and env provenance across %s late writes", async (writes) => {
    await withOpenClawTestState(
      { label: "plugin-late-write", env: { UPDATER_RETRY_TOKEN: "synthetic-before" } },
      async (state) => {
        const config = {
          plugins: {
            enabled: false,
            entries: {
              fixture: { enabled: true, config: { apiKey: "${UPDATER_RETRY_TOKEN}" } },
            },
          },
          gateway: { port: 18789, auth: { token: "${UPDATER_RETRY_TOKEN}" } },
        };
        const prepared = await prepareUpdate(state, config);
        const originalInclude = JSON.stringify(config.plugins);
        await fs.writeFile(state.statePath("plugins.json"), originalInclude);
        await state.writeConfig({ ...config, plugins: { $include: "./plugins.json" } });
        prepared.configSnapshot = await readConfigFileSnapshot();
        const write = await readConfigFileSnapshotForWrite();
        mocks.convergence.mockImplementationOnce(async ({ cfg }) =>
          convergenceResult({
            ...cfg,
            plugins: {
              ...cfg.plugins,
              entries: { fixture: { ...cfg.plugins.entries.fixture, enabled: false } },
            },
          }),
        );
        let attempts = 0;
        const update = updatePluginsAfterCoreUpdate({
          ...prepared,
          configWriteOptions: {
            ...write.writeOptions,
            beforeCommit: async () => {
              attempts++;
              if (attempts <= writes) {
                if (attempts === 1) {
                  process.env.UPDATER_RETRY_TOKEN = "synthetic-after";
                  await fs.writeFile(
                    state.statePath("plugins-next.json"),
                    JSON.stringify({ ...config.plugins, allow: ["fixture"] }),
                  );
                }
                await state.writeConfig({
                  ...config,
                  plugins: { $include: "./plugins-next.json" },
                  gateway: { ...config.gateway, port: 19000 + attempts },
                });
              }
            },
          },
        });
        if (writes === 1) {
          await expect(update).resolves.toMatchObject({ status: "ok" });
        } else {
          await expect(update).rejects.toThrow();
        }
        expect(attempts).toBe(writes === 1 ? 2 : 5);
        const root = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(root.plugins).toEqual({ $include: "./plugins-next.json" });
        expect(root.gateway).toEqual({ port: 19000 + writes, auth: config.gateway.auth });
        expect(await fs.readFile(state.statePath("plugins.json"), "utf8")).toBe(originalInclude);
        expect(JSON.parse(await fs.readFile(state.statePath("plugins-next.json"), "utf8"))).toEqual(
          {
            ...config.plugins,
            allow: ["fixture"],
            entries: {
              fixture: { enabled: writes !== 1, config: config.plugins.entries.fixture.config },
            },
          },
        );
        expect(
          await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
        ).toEqual(writes === 1 ? { fixture: { source: "archive" } } : {});
        expect(mocks.convergence).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("publishes prepared channel restoration against its original baseline", async () => {
    await withOpenClawTestState({ label: "plugin-rebase-restoration" }, async (state) => {
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        channels: { defaults: { groupPolicy: "disabled" } },
      };
      await prepareUpdate(state, config);
      const restored = { channels: { modelByChannel: { discord: { channel: "provider/model" } } } };
      const prepared = await preparePostCorePluginConfig({
        requestedChannel: null,
        preUpdateConfig: { sourceConfig: restored, authoredConfig: restored },
      });
      mocks.convergence.mockImplementationOnce(async ({ cfg }) => {
        await state.writeConfig({ ...config, gateway: { port: 19001 } });
        return convergenceResult(cfg);
      });
      await updatePluginsAfterCoreUpdate({
        root: state.root,
        channel: "stable",
        ...prepared,
        pluginInstallRecords: {},
        timeoutMs: 1000,
        json: true,
      });
      expect((await readConfigFileSnapshot()).sourceConfig).toMatchObject({
        gateway: { port: 19001 },
        channels: { ...restored.channels, defaults: { groupPolicy: "disabled" } },
      });
    });
  });
});

describe("plugin publication safety", () => {
  it.each([false, true])(
    "does not retry a postcommit failure (later edit=%s)",
    async (laterEdit) => {
      await withOpenClawTestState({ label: "plugin-postcommit" }, async (state) => {
        const config: OpenClawConfig = {
          plugins: { enabled: false, entries: { fixture: { enabled: true } } },
        };
        const prepared = await prepareUpdate(state, config);
        const include = state.statePath("plugins.json");
        const original = JSON.stringify(config.plugins);
        await fs.writeFile(include, original);
        await state.writeConfig({ plugins: { $include: "./plugins.json" } });
        prepared.configSnapshot = await readConfigFileSnapshot();
        const write = await readConfigFileSnapshotForWrite();
        mocks.convergence.mockImplementationOnce(async ({ cfg }) =>
          convergenceResult({
            ...cfg,
            plugins: {
              ...cfg.plugins,
              entries: { fixture: { enabled: false } },
            },
          }),
        );
        let refreshes = 0;
        const concurrent = JSON.stringify({ ...config.plugins, allow: ["fixture"] });
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: () => true,
          refresh: async () => {
            refreshes++;
            if (laterEdit) {
              await fs.writeFile(include, concurrent);
            }
            throw new Error("synthetic refresh failure");
          },
        });
        await expect(
          updatePluginsAfterCoreUpdate({ ...prepared, configWriteOptions: write.writeOptions }),
        ).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: laterEdit ? "not-restored" : "restored",
        });
        expect(refreshes).toBe(1);
        expect(await fs.readFile(include, "utf8")).toBe(laterEdit ? concurrent : original);
        expect(
          await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
        ).toEqual(laterEdit ? { fixture: { source: "archive" } } : {});
        expect(mocks.convergence).toHaveBeenCalledTimes(1);
      });
    },
  );

  it.each(["permission", "path"])("retains current %s refusal at publication", async (refusal) => {
    await withOpenClawTestState({ label: "plugin-publication-authority" }, async (state) => {
      const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
      const write = await readConfigFileSnapshotForWrite();
      const original = await fs.readFile(state.configPath, "utf8");
      mocks.convergence.mockImplementationOnce(async ({ cfg }) => {
        if (refusal === "permission") {
          vi.stubEnv("OPENCLAW_NIX_MODE", "1");
        } else {
          vi.stubEnv("OPENCLAW_CONFIG_PATH", state.path("other.json"));
        }
        return convergenceResult(cfg);
      });
      try {
        await expect(
          updatePluginsAfterCoreUpdate({ ...prepared, configWriteOptions: write.writeOptions }),
        ).rejects.toThrow(refusal === "permission" ? /Nix|immutable/ : /path/i);
      } finally {
        vi.unstubAllEnvs();
      }
      expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual({});
    });
  });
});

describe("updater plugin commit cancellation", () => {
  it("prints each skipped plugin and its reason after the update counts", async () => {
    await withOpenClawTestState({ label: "updater-plugin-skip-reasons" }, async (state) => {
      const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
      const message = "Package is managed outside OpenClaw.";
      mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => ({
        config: candidate,
        configChanges: [],
        installedPluginIdRecovery: new Map(),
        changes: [],
        warnings: [],
        errored: false,
        smokeFailures: [],
        installRecords: {},
        outcomes: [{ pluginId: "cursor-cli", status: "skipped", message }],
      }));
      const log = vi.fn();
      await updatePluginsAfterCoreUpdate({
        ...prepared,
        configWriteOptions: {},
        json: false,
        runtime: { log, error: vi.fn(), exit: vi.fn() },
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("1 skipped"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`cursor-cli: ${message}`));
    });
  });

  it("rolls back the tentative index after a config failure under a live owner", async () => {
    await withOpenClawTestState({ label: "updater-plugin-config-failed" }, async (state) => {
      const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
      const originalConfig = await fs.readFile(state.configPath, "utf8");
      const controller = new AbortController();
      const refusal = new Error("updater config refusal");
      const assertCurrent = () => controller.signal.throwIfAborted();
      mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => {
        await Promise.resolve();
        return {
          config: candidate,
          configChanges: [],
          installedPluginIdRecovery: new Map(),
          changes: [],
          warnings: [],
          errored: false,
          smokeFailures: [],
          installRecords: { next: { source: "archive" } },
        };
      });
      const params = {
        ...prepared,
        configWriteOptions: {
          beforeCommit: () => {
            throw refusal;
          },
        },
        assertCurrent,
      };
      await expect(
        withPluginLifecycleLease({ assertCurrent }, () => updatePluginsAfterCoreUpdate(params)),
      ).rejects.toBe(refusal);
      expect(controller.signal.aborted).toBe(false);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual({});
    });
  });
});

describe("updater explicit reference intent", () => {
  it.each([true, false])(
    "preserves reference activation only with explicit intent=%s",
    async (explicit) => {
      await withOpenClawTestState(
        { label: `updater-reference-${explicit}`, env: { BROWSER_BIN: "/fixture/browser" } },
        async (state) => {
          const prepared = await prepareUpdate(state, {
            plugins: { enabled: false },
            browser: { executablePath: "$${BROWSER_BIN}" },
          });
          const snapshot = prepared.configSnapshot;
          expect(snapshot.valid).toBe(true);
          expect(snapshot.sourceConfig.browser?.executablePath).toBe("${BROWSER_BIN}");
          mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => ({
            config: candidate,
            configChanges: [],
            installedPluginIdRecovery: new Map(),
            changes: [],
            warnings: [],
            errored: false,
            smokeFailures: [],
            installRecords: {},
          }));
          await updatePluginsAfterCoreUpdate({
            ...prepared,
            configWriteOptions: {
              explicitSetPaths: explicit ? [["browser", "executablePath"]] : undefined,
            },
          });
          const written = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          expect(written.browser.executablePath).toBe(
            explicit ? "${BROWSER_BIN}" : "$${BROWSER_BIN}",
          );
          expect(
            await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
          ).toEqual({});
        },
      );
    },
  );
});

describe("updater recovery compatibility context", () => {
  it.each([false, true])(
    "revalidates against the new host and fences later drift=%s",
    async (drift) => {
      await withOpenClawTestState(
        {
          label: "updater-recovery-host",
          env: {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.1.1",
          },
        },
        async (state) => {
          // Disabled plugins keep cohort/install work cold; convergence below models its published result.
          await fs.writeFile(state.path("package.json"), JSON.stringify({ version: "2099.1.1" }));
          const prepared = await prepareUpdate(state, {
            plugins: { enabled: false, entries: { qqbot: { enabled: false } } },
          });
          const original = await fs.readFile(state.configPath, "utf8");
          let ownerRoot = "";
          let reachedCommit = false;
          mocks.convergence.mockImplementationOnce(
            async ({ cfg: candidate, compatibilityHostVersion, env }) => {
              const owner = await seedRecoveryOwner(state, candidate, {
                minHostVersion: ">=2099.1.1",
              });
              ownerRoot = owner.root;
              const recovery = await recoverInstalledPluginConfigIds(candidate, {
                ...env,
                OPENCLAW_COMPATIBILITY_HOST_VERSION: compatibilityHostVersion,
                OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
              });
              expect(recovery.recovery.size).toBe(1);
              return {
                config: recovery.config,
                configChanges: recovery.changes,
                installedPluginIdRecovery: recovery.recovery,
                changes: [],
                warnings: [],
                errored: false,
                smokeFailures: [],
                installRecords: owner.records,
              };
            },
          );
          const update = updatePluginsAfterCoreUpdate({
            ...prepared,
            configWriteOptions: {
              beforeCommit: async () => {
                reachedCommit = true;
                if (drift) {
                  await fs.appendFile(`${ownerRoot}/openclaw.plugin.json`, "\n");
                }
              },
            },
          });
          if (drift) {
            await expect(update).rejects.toThrow("Plugin ownership changed");
            expect(reachedCommit).toBe(true);
            expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
          } else {
            await update;
            const saved = JSON.parse(await fs.readFile(state.configPath, "utf8"));
            expect(saved.plugins.entries).toEqual({ "openclaw-qqbot": { enabled: false } });
          }
        },
      );
    },
  );
});

// Model a catalog-declared alias; catalog ingestion has separate owner coverage.
vi.mock("../../plugins/official-external-plugin-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugins/official-external-plugin-catalog.js")>();
  return {
    ...actual,
    resolveOfficialExternalPluginLegacyIds: (
      entry: Parameters<typeof actual.resolveOfficialExternalPluginLegacyIds>[0],
    ) =>
      actual.resolveOfficialExternalPluginId(entry) === "openclaw-qqbot"
        ? ["qqbot"]
        : actual.resolveOfficialExternalPluginLegacyIds(entry),
  };
});
