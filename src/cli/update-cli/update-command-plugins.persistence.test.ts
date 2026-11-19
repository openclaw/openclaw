import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { recoverInstalledPluginConfigIds } from "../../commands/doctor/shared/installed-plugin-id-recovery.js";
import { seedRecoveryOwner } from "../../commands/doctor/shared/installed-plugin-id-recovery.test-support.js";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../../config/config.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  recordDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../../infra/deferred-plugin-migrations.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import * as registryRefresh from "../../plugins/registry-refresh.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({ convergence: vi.fn() }));
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: mocks.convergence,
}));
import { postCoreConvergenceResult } from "./update-cli-config.test-support.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

afterEach(() => vi.restoreAllMocks());

function convergenceResult(config: OpenClawConfig) {
  return { ...postCoreConvergenceResult(), config };
}

it.each([
  { config: "writable", change: false },
  { config: "writable", change: true },
  { config: "symlinked", change: false },
  { config: "symlinked", change: true },
  { config: "symlinked", change: false, pendingMigration: true },
])(
  "publishes plugin records for $config config: change=$change pending=$pendingMigration",
  async ({ config, change, pendingMigration = false }) => {
    await withOpenClawTestState({ label: "updater-records-only" }, async (state) => {
      const pending: DeferredPluginMigration = {
        pluginId: "canvas",
        reason: "Canvas document migration is unfinished.",
        command: "openclaw doctor --fix",
        requiresStateMigration: true,
        configPaths: [["canvasHost"]],
        validationExcludedPaths: [["canvasHost"]],
      };
      const prepared = await prepareUpdate(state, {
        plugins: { enabled: false },
        ...(pendingMigration ? { canvasHost: { root: "/retained/canvas-documents" } } : {}),
      });
      if (pendingMigration) {
        await recordDeferredPluginMigrations({ pending: [pending] });
        prepared.configSnapshot = await readConfigFileSnapshot({
          deferredPluginMigrations: [pending],
        });
        expect(prepared.configSnapshot.valid).toBe(true);
      }
      if (config === "symlinked") {
        const managed = state.path("managed-config");
        await fs.mkdir(managed);
        await fs.rename(state.configPath, managed + "/openclaw.json");
        await fs.symlink(managed + "/openclaw.json", state.configPath);
      }
      const original = await fs.readFile(state.configPath, "utf8");
      const originalLink = config === "symlinked" ? await fs.readlink(state.configPath) : undefined;
      const next = { next: { source: "archive" as const } };
      mocks.convergence.mockImplementationOnce(async ({ cfg }) => ({
        ...convergenceResult(cfg),
        changes: ["Installed fixture next."],
        installRecords: next,
        ...(change
          ? {
              config: {
                ...cfg,
                plugins: { ...cfg.plugins, entries: { next: { enabled: false } } },
              },
              configChanges: ["Disabled fixture next."],
            }
          : {}),
      }));
      const update = updatePluginsAfterCoreUpdate({
        ...prepared,
        configChanged: false,
        configWriteOptions: pendingMigration ? { deferredPluginMigrations: [pending] } : {},
      });
      const refused = change && config !== "writable";
      if (refused) {
        await expect(update).rejects.toBeInstanceOf(ConfigMutationConflictError);
        await expect(update).rejects.toMatchObject({ retryable: false });
      } else {
        expect(await update).toMatchObject({ status: "ok", changed: true });
      }
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual(refused ? {} : next);
      const saved = await fs.readFile(state.configPath, "utf8");
      if (change && !refused) {
        expect(JSON.parse(saved).plugins.entries).toEqual({ next: { enabled: false } });
      } else {
        expect(saved).toBe(original);
      }
      if (config === "symlinked") {
        expect((await fs.lstat(state.configPath)).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(state.configPath)).toBe(originalLink);
      }
    });
  },
);

it.each([false, true])(
  "binds records-only publication to the planned config link (link re-pointed=%s)",
  async (repointed) => {
    await withOpenClawTestState({ label: "updater-records-only-link" }, async (state) => {
      const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
      // A provisioned config behind a link, read for write as the update plans it.
      const managed = state.path("managed-config");
      await fs.mkdir(managed);
      await fs.rename(state.configPath, `${managed}/openclaw.json`);
      await fs.writeFile(`${managed}/other.json`, JSON.stringify({ gateway: { port: 19003 } }));
      await fs.symlink(`${managed}/openclaw.json`, state.configPath);
      const planned = await readConfigFileSnapshotForWrite();
      mocks.convergence.mockImplementationOnce(async ({ cfg }) => {
        if (repointed) {
          // The provisioner re-points the link to another valid config mid-update.
          await fs.rm(state.configPath);
          await fs.symlink(`${managed}/other.json`, state.configPath);
        }
        return {
          ...convergenceResult(cfg),
          changes: ["Installed fixture next."],
          installRecords: { next: { source: "archive" } },
        };
      });
      const update = updatePluginsAfterCoreUpdate({
        ...prepared,
        configSnapshot: planned.snapshot,
        configChanged: false,
        configWriteOptions: planned.writeOptions,
      });
      if (repointed) {
        await expect(update).rejects.toThrow("config target changed since last load");
      } else {
        await expect(update).resolves.toMatchObject({ status: "ok", changed: true });
      }
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual(repointed ? {} : { next: { source: "archive" } });
    });
  },
);

it.each([
  { edit: "a valid unrelated setting", invalid: false },
  { edit: "an invalid value", invalid: true },
])("publishes records-only around a later config edit with $edit", async ({ invalid }) => {
  await withOpenClawTestState({ label: "updater-unchanged-config-raced" }, async (state) => {
    const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
    mocks.convergence.mockImplementationOnce(async ({ cfg }) => ({
      ...convergenceResult(cfg),
      changes: ["Installed fixture next."],
      installRecords: { next: { source: "archive" } },
    }));
    const edited = { plugins: { enabled: false }, gateway: { port: invalid ? "invalid" : 19002 } };
    const result = await updatePluginsAfterCoreUpdate({
      ...prepared,
      configChanged: false,
      // An editor outside the config lock writes after the updater found nothing to change.
      configWriteOptions: {
        beforeCommit: async () => {
          await fs.writeFile(state.configPath, JSON.stringify(edited));
        },
      },
    });
    // Records match the config they were published against: an invalid edit defers them.
    expect(result.status).toBe(invalid ? "warning" : "ok");
    if (invalid) {
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ reason: "plugin-config-conflict" }),
      );
    }
    expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env })).toEqual(
      invalid ? {} : { next: { source: "archive" } },
    );
    expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(edited);
  });
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

it.each(["unrelated", "same-value", "conflict", "include"])(
  "settles plugin finalization after a %s config write",
  async (change) => {
    await withOpenClawTestState({ label: `updater-config-${change}` }, async (state) => {
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
      expect(prepared.configSnapshot.valid).toBe(true);
      const preparedWrite = await readConfigFileSnapshotForWrite();
      mocks.convergence.mockImplementationOnce(async ({ cfg }) => {
        // A real config writer runs after the updater captured its planning baseline.
        const concurrent = {
          ...config,
          gateway: { port: 19001 },
          plugins: {
            ...config.plugins,
            entries: { fixture: { enabled: change === "unrelated" || change === "include" } },
          },
        };
        if (change === "include") {
          await fs.writeFile(
            state.statePath("plugins.json"),
            JSON.stringify({ ...concurrent.plugins, allow: ["fixture"] }),
          );
        } else {
          await state.writeConfig(concurrent);
        }
        return {
          ...convergenceResult(cfg),
          config: {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              entries: change === "conflict" ? {} : { fixture: { enabled: false } },
            },
          },
          configChanges: ["Reconciled fixture policy."],
          installRecords: { fixture: { source: "archive" } },
        };
      });
      const result = await updatePluginsAfterCoreUpdate({
        ...prepared,
        configWriteOptions: preparedWrite.writeOptions,
      });
      const saved = (await readConfigFileSnapshot()).sourceConfig;
      expect(saved.gateway?.port).toBe(change === "include" ? 18789 : 19001);
      expect(saved.plugins?.entries?.fixture?.enabled).toBe(false);
      if (change === "include") {
        expect(saved.plugins?.allow).toEqual(["fixture"]);
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8")).plugins).toEqual({
          $include: "./plugins.json",
        });
      }
      expect(result.status).toBe(change === "conflict" ? "warning" : "ok");
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual(change === "conflict" ? {} : { fixture: { source: "archive" } });
      if (change === "conflict") {
        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            reason: "plugin-config-conflict",
            guidance: ["openclaw plugins doctor", "openclaw doctor --fix"],
          }),
        );
      }
    });
  },
);

it.each([1, 5])("bounds publication retries after %s late writes", async (writes) => {
  await withOpenClawTestState(
    {
      label: `updater-late-writes-${writes}`,
      env: { UPDATER_RETRY_TOKEN: "synthetic-before-retry" },
    },
    async (state) => {
      const config = {
        plugins: {
          enabled: false,
          entries: { fixture: { enabled: true, config: { apiKey: "${UPDATER_RETRY_TOKEN}" } } },
        },
        gateway: { port: 18789, auth: { token: "${UPDATER_RETRY_TOKEN}" } },
      };
      const prepared = await prepareUpdate(state, config);
      const originalInclude = JSON.stringify(config.plugins);
      await fs.writeFile(state.statePath("plugins.json"), originalInclude);
      await state.writeConfig({ ...config, plugins: { $include: "./plugins.json" } });
      prepared.configSnapshot = await readConfigFileSnapshot();
      const preparedWrite = await readConfigFileSnapshotForWrite();
      mocks.convergence.mockImplementationOnce(async ({ cfg }) => ({
        ...convergenceResult(cfg),
        config: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: { fixture: { ...cfg.plugins.entries.fixture, enabled: false } },
          },
        },
        installRecords: { fixture: { source: "archive" } },
      }));
      let attempts = 0;
      const result = await updatePluginsAfterCoreUpdate({
        ...prepared,
        configWriteOptions: {
          ...preparedWrite.writeOptions,
          beforeCommit: async () => {
            attempts += 1;
            if (attempts <= writes) {
              // A manual editor does not participate in the OpenClaw write lock.
              if (attempts === 1) {
                process.env.UPDATER_RETRY_TOKEN = "synthetic-after-retry";
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
      expect(attempts).toBe(writes === 1 ? 2 : 5);
      expect(result.status).toBe(writes === 1 ? "ok" : "warning");
      expect((await readConfigFileSnapshot()).sourceConfig.gateway?.port).toBe(19000 + writes);
      const root = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(root.plugins).toEqual({ $include: "./plugins-next.json" });
      expect(root.gateway.auth.token).toBe("${UPDATER_RETRY_TOKEN}");
      expect(await fs.readFile(state.statePath("plugins.json"), "utf8")).toBe(originalInclude);
      expect(JSON.parse(await fs.readFile(state.statePath("plugins-next.json"), "utf8"))).toEqual({
        ...config.plugins,
        allow: ["fixture"],
        entries: {
          fixture: {
            enabled: writes !== 1,
            config: { apiKey: "${UPDATER_RETRY_TOKEN}" },
          },
        },
      });
      expect(
        await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
      ).toEqual(writes === 1 ? { fixture: { source: "archive" } } : {});
    },
  );
});

it("prints each skipped plugin and its reason after the update counts", async () => {
  await withOpenClawTestState({ label: "updater-plugin-skip-reasons" }, async (state) => {
    const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
    const message = "Package is managed outside OpenClaw.";
    mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => ({
      ...convergenceResult(candidate),
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

it("refuses records-only publication when update authority is revoked before the index write", async () => {
  await withOpenClawTestState({ label: "updater-records-only-revoked" }, async (state) => {
    const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const controller = new AbortController();
    const assertCurrent = () => controller.signal.throwIfAborted();
    mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => ({
      ...convergenceResult(candidate),
      changes: ["Installed fixture next."],
      installRecords: { next: { source: "archive" } },
    }));
    const refresh = vi.spyOn(registryRefresh, "refreshPluginRegistryAfterConfigMutation");
    await expect(
      withPluginLifecycleLease({ assertCurrent }, () =>
        updatePluginsAfterCoreUpdate({
          ...prepared,
          configChanged: false,
          // Another updater takes over after the decision, before any persistent effect.
          configWriteOptions: { beforeCommit: () => controller.abort(new Error("revoked")) },
          assertCurrent,
        }),
      ),
    ).rejects.toThrow("revoked");
    expect(refresh).not.toHaveBeenCalled();
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env })).toEqual(
      {},
    );
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
      // A real config change, so the refusal lands after the tentative index write.
      return {
        ...convergenceResult(candidate),
        config: { ...candidate, plugins: { ...candidate.plugins, allow: ["next"] } },
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
    expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env })).toEqual(
      {},
    );
  });
});
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
        // An unrelated real change makes the update write the file either way.
        mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => ({
          ...convergenceResult(candidate),
          config: { ...candidate, plugins: { ...candidate.plugins, allow: ["fixture"] } },
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
              ...convergenceResult(recovery.config),
              config: recovery.config,
              configChanges: recovery.changes,
              installedPluginIdRecovery: recovery.recovery,
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
