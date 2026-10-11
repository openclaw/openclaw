import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { refreshInstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginLifecycleRuntimeApply } from "./lifecycle.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
} from "./loader.test-fixtures.js";
import { reloadManagedPlugin } from "./management-mutations.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resolveControlPlaneRegistryParams } from "./plugin-registry-snapshot.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

vi.mock("../gateway/call.js", () => {
  throw new Error("Offline plugin policy changes must not load Gateway RPC");
});
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

it("persists offline CLI plugin policy without loading Gateway RPC or heavy plugin services", async () => {
  const stateDir = makePluginLoaderTempDir();
  const bundledDir = makePluginLoaderTempDir();
  const pluginId = "policy-only";
  const writeBundledPlugin = (id: string, version: string) => {
    const rootDir = path.join(bundledDir, id);
    fs.mkdirSync(rootDir, { recursive: true });
    return createColdPluginFixture({
      rootDir,
      pluginId: id,
      packageName: `@fixture/${id}`,
      packageVersion: version,
      manifest: {
        version,
        providers: [],
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
      },
    });
  };
  writeBundledPlugin(pluginId, "1.0.0");
  await withEnvAsync(
    {
      OPENCLAW_HOME: stateDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    async () => {
      const readPolicy = async () => {
        const { snapshot } = await readConfigFileSnapshotForWrite();
        await using cache = createPluginCache();
        return withPluginCache(cache, () => {
          const index = readPersistedInstalledPluginIndexSync();
          if (!index) {
            throw new Error("CLI policy mutation did not persist the plugin index");
          }
          const fresh = refreshInstalledPluginIndex(
            resolveControlPlaneRegistryParams({
              config: snapshot.runtimeConfig,
              env: process.env,
              installRecords: {},
              reason: "policy-changed" as const,
              now: () => new Date(index.generatedAtMs),
            }),
          );
          expect(index).toEqual(fresh);
          return { config: snapshot.sourceConfig, index };
        });
      };
      await writeConfigFile({ plugins: { entries: { [pluginId]: { enabled: false } } } });
      const { runPluginsEnableCommand, runPluginsDisableCommand } =
        await import("../cli/plugins-cli.runtime.js");
      await runPluginsEnableCommand(pluginId);
      const enabled = await readPolicy();
      expect(enabled.config.plugins?.entries?.[pluginId]?.enabled).toBe(true);
      const firstPlugin = enabled.index.plugins.find((plugin) => plugin.pluginId === pluginId);
      expect(firstPlugin).toMatchObject({ enabled: true, packageVersion: "1.0.0" });
      await runPluginsDisableCommand(pluginId);
      const disabled = await readPolicy();
      expect(disabled.config.plugins?.entries?.[pluginId]?.enabled).toBe(false);
      expect(disabled.index.plugins.find((plugin) => plugin.pluginId === pluginId)?.enabled).toBe(
        false,
      );

      const addedId = "policy-added";
      writeBundledPlugin(pluginId, "2.0.0");
      writeBundledPlugin(addedId, "1.0.0");
      await runPluginsEnableCommand(addedId);
      const refreshed = await readPolicy();
      expect(refreshed.config.plugins?.entries).toMatchObject({
        [pluginId]: { enabled: false },
        [addedId]: { enabled: true },
      });
      const updated = refreshed.index.plugins.find((plugin) => plugin.pluginId === pluginId);
      expect(updated).toMatchObject({ enabled: false, packageVersion: "2.0.0" });
      expect(updated?.manifestHash).not.toBe(firstPlugin?.manifestHash);
      expect(refreshed.index.plugins.find((plugin) => plugin.pluginId === addedId)).toMatchObject({
        enabled: true,
        packageVersion: "1.0.0",
      });
    },
  );
});

async function writeReloadArtifact(rootDir: string, pluginId: string, tool: string) {
  await fs.promises.mkdir(rootDir);
  createColdPluginFixture({
    rootDir,
    pluginId,
    manifest: {
      providers: [],
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
      contracts: { tools: [tool] },
    },
  });
}

describe("reload consent and current install preconditions", () => {
  let testState: OpenClawTestState | undefined;
  afterEach(async () => {
    await testState?.cleanup();
  });

  async function prepareReload() {
    const state = await createOpenClawTestState({ label: "reload-consent-record" });
    testState = state;
    const rootDir = state.path("plugin");
    await writeReloadArtifact(rootDir, "reload-proof", "proof.read");
    const config = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: {
        allow: ["reload-proof"],
        load: { paths: [rootDir] },
        entries: { "reload-proof": { enabled: true } },
      },
    };
    await state.writeConfig(config);
    await seedInstalledPluginIndex(
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

  it.each(["transaction", "commit"] as const)(
    "preserves durable consent when reload authority is revoked at worker %s admission",
    async (stage) => {
      const { state, record, reviewToken, applyRuntime } = await prepareReload();
      const refused = new Error("plugin administrator authority revoked");
      let current = true;
      let reachedAdmission = false;
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((request, grant) => {
            if (
              request.stage === stage &&
              isRecord(request.facts) &&
              request.facts.kind === "state-lease"
            ) {
              reachedAdmission = true;
              current = false;
            }
            admit(request, grant);
          }, attachment),
        );
      try {
        await expect(
          reloadManagedPlugin({
            plugins: [{ pluginId: "reload-proof" }],
            acknowledgeCapabilities: { reviewToken },
            env: state.env,
            applyRuntime,
            beforePersistentApply() {
              if (!current) {
                throw refused;
              }
            },
          }),
        ).rejects.toBe(refused);
      } finally {
        admission.mockRestore();
      }
      expect(reachedAdmission).toBe(true);
      expect(
        readPersistedInstalledPluginIndexInstallRecords({ env: state.env })?.["reload-proof"],
      ).toEqual(record);
      expect(applyRuntime).not.toHaveBeenCalled();
    },
  );

  it("stops a multi-target reload when another selected package needs a different review", async () => {
    const { state, record, reviewToken, applyRuntime, config } = await prepareReload();
    const secondRoot = state.path("second-plugin");
    await writeReloadArtifact(secondRoot, "second-proof", "second.write");
    const cohortConfig = {
      ...config,
      plugins: {
        allow: ["reload-proof", "second-proof"],
        load: { paths: [...config.plugins.load.paths, secondRoot] },
        entries: { ...config.plugins.entries, "second-proof": { enabled: true } },
      },
    };
    await state.writeConfig(cohortConfig);
    await seedInstalledPluginIndex(
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
