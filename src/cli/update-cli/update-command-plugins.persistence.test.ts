import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverInstalledPluginConfigIds } from "../../commands/doctor/shared/installed-plugin-id-recovery.js";
import { seedRecoveryOwner } from "../../commands/doctor/shared/installed-plugin-id-recovery.test-support.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../../infra/deferred-plugin-migrations.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
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
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

afterEach(() => vi.restoreAllMocks());

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

describe("updater plugin commit cancellation", () => {
  it.each([false, true])(
    "carries pending migrations from unchanged convergence to completion (pending=%s)",
    async (pending) => {
      await withOpenClawTestState({ label: "updater-convergence-facts" }, async (state) => {
        const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
        mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => {
          if (pending) {
            await recordDeferredPluginMigrations({
              pending: [
                {
                  pluginId: "fixture",
                  reason: "Convergence deferred",
                  command: "openclaw doctor --fix",
                },
              ],
            });
          }
          return {
            config: candidate,
            configChanges: [],
            installedPluginIdRecovery: new Map(),
            changes: [],
            warnings: [],
            errored: false,
            smokeFailures: [],
            installRecords: {},
          };
        });
        const result = await updatePluginsAfterCoreUpdate({
          ...prepared,
          configChanged: false,
          configWriteOptions: {},
        });
        expect(result).toMatchObject({ changed: false, deferredMigrationsPending: pending });
      });
    },
  );

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
      expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual({});
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
          expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual({});
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
