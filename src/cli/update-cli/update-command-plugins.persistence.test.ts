import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverInstalledPluginConfigIds } from "../../commands/doctor/shared/installed-plugin-id-recovery.js";
import { seedRecoveryOwner } from "../../commands/doctor/shared/installed-plugin-id-recovery.test-support.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({ convergence: vi.fn() }));
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: mocks.convergence,
}));
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

afterEach(() => vi.restoreAllMocks());

describe("updater plugin commit cancellation", () => {
  it.each(["index", "config", "config-failed"] as const)(
    "fences config writes and settles tentative index custody after %s refusal",
    async (effect) => {
      await withOpenClawTestState({ label: `updater-plugin-${effect}` }, async (state) => {
        // Config-write custody uses a host control store outside the profile database.
        const control = state.path("control");
        await fs.mkdir(control, { mode: 0o700 });
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const cfg = { plugins: { enabled: false } };
        await state.writeConfig(cfg);
        const originalConfig = await fs.readFile(state.configPath, "utf8");
        await seedInstalledPluginIndex({}, { config: cfg, env: state.env });
        const controller = new AbortController();
        const refusal = new Error(`updater ${effect} refusal`);
        const assertCurrent = () => controller.signal.throwIfAborted();
        mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) => {
          await Promise.resolve();
          if (effect === "index") {
            controller.abort(refusal);
          }
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
          root: state.root,
          channel: "stable" as const,
          configSnapshot: await readConfigFileSnapshot(),
          configWriteOptions: {
            beforeCommit: () => {
              if (effect === "config-failed") {
                throw refusal;
              }
              if (effect === "config") {
                controller.abort(refusal);
              }
            },
          },
          configChanged: true,
          pluginInstallRecords: {},
          timeoutMs: 1_000,
          json: true,
          assertCurrent,
        };
        const update = () => updatePluginsAfterCoreUpdate(params);
        await expect(
          effect === "config-failed"
            ? withPluginLifecycleLease({ assertCurrent }, update)
            : update(),
        ).rejects.toBe(refusal);
        if (effect === "config-failed") {
          expect(controller.signal.aborted).toBe(false);
        }
        expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
        // A revoked continuous owner cannot authorize compensating writes. A plain
        // commit failure still rolls back under the live owner; pre-index refusal writes nothing.
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          effect === "config" ? { next: { source: "archive" } } : {},
        );
      });
    },
  );
});

describe("updater explicit reference intent", () => {
  it.each([true, false])(
    "preserves reference activation only with explicit intent=%s",
    async (explicit) => {
      await withOpenClawTestState(
        { label: `updater-reference-${explicit}`, env: { BROWSER_BIN: "/fixture/browser" } },
        async (state) => {
          const control = state.path("control");
          await fs.mkdir(control, { mode: 0o700 });
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
          const cfg = {
            plugins: { enabled: false },
            browser: { executablePath: "$${BROWSER_BIN}" },
          };
          await state.writeConfig(cfg);
          await seedInstalledPluginIndex({}, { config: cfg, env: state.env });
          const snapshot = await readConfigFileSnapshot();
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
            root: state.root,
            channel: "stable",
            configSnapshot: snapshot,
            configWriteOptions: {
              explicitSetPaths: explicit ? [["browser", "executablePath"]] : undefined,
            },
            configChanged: true,
            pluginInstallRecords: {},
            timeoutMs: 1_000,
            json: true,
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
          const control = state.path("control");
          await fs.mkdir(control, { mode: 0o700 });
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
          // Disabled plugins keep cohort/install work cold; convergence below models its published result.
          const cfg = { plugins: { enabled: false, entries: { qqbot: { enabled: false } } } };
          await state.writeConfig(cfg);
          await fs.writeFile(state.path("package.json"), JSON.stringify({ version: "2099.1.1" }));
          await seedInstalledPluginIndex({}, { config: cfg, env: state.env });
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
            root: state.root,
            channel: "stable",
            configSnapshot: await readConfigFileSnapshot(),
            configWriteOptions: {
              beforeCommit: async () => {
                reachedCommit = true;
                if (drift) {
                  await fs.appendFile(`${ownerRoot}/openclaw.plugin.json`, "\n");
                }
              },
            },
            configChanged: true,
            pluginInstallRecords: {},
            timeoutMs: 1_000,
            json: true,
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
