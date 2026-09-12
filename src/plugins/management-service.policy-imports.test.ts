import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import type { PluginLifecycleRuntimeApply } from "./lifecycle.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { reloadManagedPlugin } from "./management-mutations.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

vi.mock("./management-install.js", () => {
  throw new Error("Plugin policy changes must not load the installation implementation");
});
vi.mock("./management-uninstall.js", () => {
  throw new Error("Plugin policy changes must not load the removal implementation");
});

vi.mock("./install-persistence.js", () => {
  throw new Error("Plugin policy changes must not load install persistence");
});
vi.mock("./status.js", () => {
  throw new Error("Bundled plugin policy changes must not load runtime diagnostics");
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  closeOpenClawStateDatabaseForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("persists CLI plugin policy without loading installation, removal, or runtime diagnostics", async () => {
  const stateDir = makePluginLoaderTempDir();
  const bundledDir = makePluginLoaderTempDir();
  const pluginId = "policy-only";
  writePlugin({
    id: pluginId,
    dir: path.join(bundledDir, pluginId),
    filename: "index.cjs",
    body: `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };`,
  });
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    async () => {
      await writeConfigFile({ plugins: { entries: { [pluginId]: { enabled: false } } } });
      const { runPluginsEnableCommand, runPluginsDisableCommand } =
        await import("../cli/plugins-cli.runtime.js");
      await runPluginsEnableCommand(pluginId);
      expect(
        (await readConfigFileSnapshotForWrite()).snapshot.sourceConfig.plugins?.entries?.[pluginId]
          ?.enabled,
      ).toBe(true);
      await runPluginsDisableCommand(pluginId);
      expect(
        JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8")).plugins.entries[
          pluginId
        ].enabled,
      ).toBe(false);
    },
  );
});

describe("reload consent and current install preconditions", () => {
  let testState: OpenClawTestState | undefined;
  afterEach(async () => {
    await testState?.cleanup();
  });

  async function prepareReload() {
    const state = await createOpenClawTestState({ label: "reload-consent-record" });
    testState = state;
    const rootDir = state.path("plugin");
    await fs.promises.mkdir(rootDir);
    createColdPluginFixture({
      rootDir,
      pluginId: "reload-proof",
      manifest: {
        providers: [],
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        contracts: { tools: ["proof.read"] },
      },
    });
    const config = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: {
        allow: ["reload-proof"],
        load: { paths: [rootDir] },
        entries: { "reload-proof": { enabled: true } },
      },
    };
    await state.writeConfig(config);
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        "reload-proof": {
          source: "path",
          sourcePath: rootDir,
          installPath: rootDir,
          version: "1.0.0",
        },
      },
      { env: state.env, config },
    );
    const records = readPersistedInstalledPluginIndexInstallRecords({ env: state.env });
    const record = records?.["reload-proof"];
    if (!record) {
      throw new Error("Expected the actual persisted install record");
    }
    const reviewToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(rootDir, state.env, { config }),
    );
    const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
      request.assertInvokerOwned?.();
      return { operationId: "reload-proof", generation: 1, pluginIds: [...request.pluginIds] };
    });
    return { state, record, reviewToken, applyRuntime, config };
  }

  it("rejects an expected install hash changed by the actual consent write before runtime publication", async () => {
    const { state, record, reviewToken, applyRuntime } = await prepareReload();
    const target = { pluginId: "reload-proof", installHash: hashStableJson(record) };
    const request = { plugins: [target], acknowledgeCapabilities: { reviewToken } };
    let failure: unknown;
    // This combined form is a new public contract. Exercise the real management
    // owner directly so baseline proof reaches consent, not the old wire rejection.
    await reloadManagedPlugin({ ...request, env: state.env, applyRuntime }).catch(
      (error: unknown) => {
        failure = error;
      },
    );
    const current = readPersistedInstalledPluginIndexInstallRecords({ env: state.env })?.[
      target.pluginId
    ];
    expect(current?.acceptedSurfaceHash).toBe(reviewToken);
    expect(hashStableJson(current)).not.toBe(target.installHash);
    expect(request.plugins[0]?.installHash).toBe(hashStableJson(record));
    expect(applyRuntime).not.toHaveBeenCalled();
    expect(failure).toMatchObject({
      message:
        "Plugin reload-proof changed after the installation batch. Inspect it before reloading.",
    });
    await expect(
      reloadManagedPlugin({
        plugins: [{ pluginId: target.pluginId, installHash: hashStableJson(current) }],
        env: state.env,
        applyRuntime,
      }),
    ).resolves.toMatchObject({ pluginIds: [target.pluginId], application: { generation: 1 } });
    expect(applyRuntime).toHaveBeenCalledOnce();
  });

  it("rejects an acknowledgment for a different declared surface without persistence or publication", async () => {
    const { state, record, applyRuntime } = await prepareReload();
    const foreignRoot = state.path("foreign-plugin");
    await fs.promises.mkdir(foreignRoot);
    createColdPluginFixture({
      rootDir: foreignRoot,
      pluginId: "foreign-proof",
      manifest: {
        providers: [],
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        contracts: { tools: ["foreign.write"] },
      },
    });
    const foreignToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(foreignRoot, state.env),
    );
    const request = {
      plugins: [{ pluginId: "reload-proof", installHash: hashStableJson(record) }],
      acknowledgeCapabilities: { reviewToken: foreignToken },
    };
    await expect(
      reloadManagedPlugin({ ...request, env: state.env, applyRuntime }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "reload-proof" } });
    const current = readPersistedInstalledPluginIndexInstallRecords({ env: state.env })?.[
      "reload-proof"
    ];
    expect(current).toEqual(record);
    expect(applyRuntime).not.toHaveBeenCalled();
  });

  it("stops a multi-target reload when another selected package needs a different review", async () => {
    const { state, record, reviewToken, applyRuntime, config } = await prepareReload();
    const secondRoot = state.path("second-plugin");
    await fs.promises.mkdir(secondRoot);
    createColdPluginFixture({
      rootDir: secondRoot,
      pluginId: "second-proof",
      manifest: {
        providers: [],
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        contracts: { tools: ["second.write"] },
      },
    });
    const cohortConfig = {
      ...config,
      plugins: {
        allow: ["reload-proof", "second-proof"],
        load: { paths: [...config.plugins.load.paths, secondRoot] },
        entries: { ...config.plugins.entries, "second-proof": { enabled: true } },
      },
    };
    await state.writeConfig(cohortConfig);
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        "reload-proof": record,
        "second-proof": {
          source: "path",
          sourcePath: secondRoot,
          installPath: secondRoot,
          version: "1.0.0",
        },
      },
      { env: state.env, config: cohortConfig },
    );
    await expect(
      reloadManagedPlugin({
        plugins: [{ pluginId: "reload-proof" }, { pluginId: "second-proof" }],
        acknowledgeCapabilities: { reviewToken },
        env: state.env,
        applyRuntime,
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "second-proof" } });
    const current = readPersistedInstalledPluginIndexInstallRecords({ env: state.env });
    expect(current?.["reload-proof"]?.acceptedSurfaceHash).toBe(reviewToken);
    expect(current?.["second-proof"]?.acceptedSurface).toBeUndefined();
    expect(applyRuntime).not.toHaveBeenCalled();
  });
});
