import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { recoverInstalledPluginConfigIds } from "../../commands/doctor/shared/installed-plugin-id-recovery.js";
import { seedRecoveryOwner } from "../../commands/doctor/shared/installed-plugin-id-recovery.test-support.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { resolvePluginInstallTransactionRequest } from "../../plugins/install-transaction.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../../plugins/test-helpers/managed-npm-plugin.js";
import { beginUpdatePluginCohort } from "../../plugins/update-cohort-recovery.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({ convergence: vi.fn() }));
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: mocks.convergence,
}));
import { postCoreConvergenceResult } from "./update-cli-config.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import { convergePostCoreUpdatePlugins } from "./update-command-resume.js";

afterEach(() => vi.restoreAllMocks());

function convergenceResult(config: OpenClawConfig) {
  return { ...postCoreConvergenceResult(), config };
}

it.each([
  { owner: "shipped post-core parent", postCore: true, requiresCohort: false, retained: false },
  { owner: "owning outer updater", postCore: false, requiresCohort: true, retained: false },
  { owner: "retained post-core parent", postCore: true, requiresCohort: false, retained: true },
])("keeps plugin publication bound to the $owner contract", async (scenario) => {
  await withOpenClawTestState(
    {
      label: "updater-cohort-parent-contract",
      env: { OPENCLAW_UPDATE_POST_CORE: scenario.postCore ? "1" : undefined },
    },
    async (state) => {
      await prepareUpdate(state, { plugins: { enabled: false } });
      const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const installPath = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@example/next",
        pluginId: "next",
        version: "1.0.0",
      });
      const next = {
        next: {
          source: "npm" as const,
          spec: "@example/next@1.0.0",
          version: "1.0.0",
          installPath,
        },
      };
      if (!scenario.requiresCohort) {
        mocks.convergence.mockImplementationOnce(async ({ cfg }) => ({
          ...convergenceResult(cfg),
          changes: ["Installed managed fixture next."],
          installRecords: next,
        }));
      }
      await withUpdateCommandExecutor(runId, async (executor) => {
        const fence = await executor.enter(state.root);
        if (scenario.retained) {
          const runtime = {
            root: state.root,
            nodePath: process.execPath,
            version: "2026.10.9",
            buildId: "fixture",
          };
          await beginUpdatePluginCohort({
            runId,
            installKey: state.root,
            from: runtime,
            to: { ...runtime, version: "2026.10.10" },
            env: state.env,
            fence,
          });
        }
        const beforeCalls = mocks.convergence.mock.calls.length;
        const convergence = convergePostCoreUpdatePlugins({
          root: state.root,
          channel: "stable",
          requestedChannel: null,
          opts: { json: true, run: { runId, env: state.env, executorFence: fence } },
          requiresCohort: scenario.requiresCohort,
          timeoutMs: 1_000,
          assertCurrent: fence.assertCurrent,
        });
        if (scenario.requiresCohort) {
          await expect(convergence).rejects.toThrow(
            "The outer updater did not retain the plugin cohort before activation",
          );
          expect(mocks.convergence.mock.calls).toHaveLength(beforeCalls);
          expect(
            await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
          ).toEqual({});
          return;
        }
        await convergence;
        expect(
          await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }),
        ).toEqual(next);
        const pair = loadPluginCohortRecovery(runId, { env: state.env });
        if (scenario.retained) {
          expect(pair?.cohort).toMatchObject({ disposition: "pending", settledPublications: 0 });
          expect(pair?.cohort.publications).toContainEqual(
            expect.objectContaining({ kind: "records" }),
          );
        } else {
          expect(pair).toBeUndefined();
        }
      });
    },
  );
});

it("still requires the live executor for a shipped post-core parent", async () => {
  await withOpenClawTestState(
    { label: "updater-post-core-native-authority", env: { OPENCLAW_UPDATE_POST_CORE: "1" } },
    async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const original = await fs.readFile(state.configPath, "utf8");
      await expect(
        convergePostCoreUpdatePlugins({
          root: state.root,
          channel: "stable",
          requestedChannel: null,
          opts: { json: true },
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("Plugin cohort convergence requires its live outer update executor");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
    },
  );
});

it("retains published artifacts when install commit cleanup fails", async () => {
  await withOpenClawTestState({ label: "updater-plugin-commit-cleanup" }, async (state) => {
    const prepared = await prepareUpdate(state, { plugins: { enabled: false } });
    const fence = { assertCurrent() {} };
    const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
    const runtime = {
      root: state.root,
      nodePath: process.execPath,
      version: "2026.10.9",
      buildId: "fixture",
    };
    await beginUpdatePluginCohort({
      runId,
      installKey: state.root,
      from: runtime,
      to: { ...runtime, version: "2026.10.10" },
      env: state.env,
      fence,
    });
    const files = [state.path("published-first"), state.path("published-second")];
    await Promise.all(files.map((file) => fs.writeFile(file, "published")));
    const failure = new Error("first package commit cleanup failed");
    const transactions = files.map((file, index) => ({
      commit: async () => {
        if (index === 0) {
          throw failure;
        }
      },
      rollback: vi.fn(() => fs.rm(file)),
    }));
    mocks.convergence.mockImplementationOnce(async (owner) => {
      const sink = resolvePluginInstallTransactionRequest(owner)?.transactionSink;
      if (!sink) {
        throw new Error("Convergence lost its deferred transaction sink");
      }
      sink.push(...transactions);
      return {
        ...convergenceResult(owner.cfg),
        installRecords: { first: { source: "archive" }, second: { source: "archive" } },
      };
    });
    await expect(
      updatePluginsAfterCoreUpdate({
        ...prepared,
        configWriteOptions: {},
        cohort: { runId, env: state.env, fence },
      }),
    ).rejects.toThrow("Plugin install transaction commit failed");
    expect(await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env })).toEqual({
      first: { source: "archive" },
      second: { source: "archive" },
    });
    expect(await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).toEqual([
      "published",
      "published",
    ]);
    for (const transaction of transactions) {
      expect(transaction.rollback).not.toHaveBeenCalled();
    }
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
        ...convergenceResult(candidate),
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
        mocks.convergence.mockImplementationOnce(async ({ cfg: candidate }) =>
          convergenceResult(candidate),
        );
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
