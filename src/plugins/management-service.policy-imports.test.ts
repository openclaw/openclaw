import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import type { PluginLifecycleRuntimeApply } from "./lifecycle.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { reloadManagedPlugin } from "./management-mutations.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

const coldManifest = { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] };

const forbidServiceImport = vi.hoisted(() => () => {
  throw new Error("Offline plugin policy must not import Gateway RPC or heavy plugin services");
});
// mock-isolation: The offline policy boundary must never load Gateway RPC.
vi.mock("../gateway/call.js", forbidServiceImport);
// mock-isolation: The offline policy boundary must never load installation services.
vi.mock("./management-install.js", forbidServiceImport);
// mock-isolation: The offline policy boundary must never load uninstallation services.
vi.mock("./management-uninstall.js", forbidServiceImport);
// mock-isolation: The offline policy boundary must never load installation persistence.
vi.mock("./install-persistence.js", forbidServiceImport);
// mock-isolation: The offline policy boundary must never load the heavy status service.
vi.mock("./status.js", forbidServiceImport);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  closeOpenClawStateDatabaseForTest();
});
async function createState() {
  const state = await createOpenClawTestState({ label: "plugin-policy" });
  onTestFinished(() => state.cleanup());
  return state;
}

it("persists offline CLI plugin policy without loading Gateway RPC or heavy plugin services", async () => {
  const state = await createState();
  const bundledDir = state.path("bundled");
  Object.assign(state.envVars, {
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  });
  state.applyEnv();
  const pluginId = "policy-only";
  const writeBundledPlugin = (id: string, version: string) => {
    const rootDir = path.join(bundledDir, id);
    fs.mkdirSync(rootDir, { recursive: true });
    return createColdPluginFixture({
      rootDir,
      pluginId: id,
      packageName: `@fixture/${id}`,
      packageVersion: version,
      manifest: { ...coldManifest, version },
    });
  };
  writeBundledPlugin(pluginId, "1.0.0");
  const readPolicy = async () => {
    const { snapshot } = await readConfigFileSnapshotForWrite();
    await using cache = createPluginCache();
    return withPluginCache(cache, () => {
      const index = readPersistedInstalledPluginIndexSync();
      assert(index, "CLI policy mutation did not persist the plugin index");
      return { config: snapshot.sourceConfig, index };
    });
  };
  const expectPolicy = async (id: string, enabled: boolean, packageVersion?: string) => {
    const { config, index } = await readPolicy();
    expect(config.plugins?.entries?.[id]?.enabled).toBe(enabled);
    const plugin = index.plugins.find((entry) => entry.pluginId === id);
    expect(plugin).toMatchObject({ enabled, ...(packageVersion ? { packageVersion } : {}) });
    return plugin;
  };
  await writeConfigFile({ plugins: { entries: { [pluginId]: { enabled: false } } } });
  const { runPluginsEnableCommand, runPluginsDisableCommand } =
    await import("../cli/plugins-cli.enable.js");
  await runPluginsEnableCommand(pluginId);
  const firstPlugin = await expectPolicy(pluginId, true, "1.0.0");
  await runPluginsDisableCommand(pluginId);
  await expectPolicy(pluginId, false);

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
});

describe("reload consent and current install preconditions", () => {
  async function prepareReload(second = false) {
    const state = await createState();
    const packages = [
      { id: "reload-proof", root: state.path("plugin"), tool: "proof.read" },
      ...(second
        ? [{ id: "second-proof", root: state.path("second-plugin"), tool: "second.write" }]
        : []),
    ];
    const installs: Record<string, PluginInstallRecord> = {};
    for (const { id, root, tool } of packages) {
      await fs.promises.mkdir(root);
      createColdPluginFixture({
        rootDir: root,
        pluginId: id,
        manifest: { ...coldManifest, contracts: { tools: [tool] } },
      });
      installs[id] = { source: "path", sourcePath: root, installPath: root, version: "1.0.0" };
    }
    const config = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: {
        allow: packages.map((pkg) => pkg.id),
        load: { paths: packages.map((pkg) => pkg.root) },
        entries: Object.fromEntries(packages.map((pkg) => [pkg.id, { enabled: true }])),
      },
    };
    await state.writeConfig(config);
    await seedInstalledPluginIndex(installs, { env: state.env, config });
    const readRecords = () =>
      readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env });
    const record = (await readRecords())?.["reload-proof"];
    assert(record, "Expected the actual persisted install record");
    const reviewToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(packages[0]!.root, state.env, { config }),
    );
    const applyRuntime = vi.fn<PluginLifecycleRuntimeApply>(async (request) => {
      request.assertInvokerOwned?.();
      return { operationId: "reload-proof", generation: 1, pluginIds: [...request.pluginIds] };
    });
    const reload = (
      request: Omit<Parameters<typeof reloadManagedPlugin>[0], "env" | "applyRuntime">,
    ) => reloadManagedPlugin({ ...request, env: state.env, applyRuntime });
    return { record, reviewToken, applyRuntime, reload, readRecords };
  }

  it("rejects an expected install hash changed by the actual consent write before runtime publication", async () => {
    const { record, reviewToken, applyRuntime, reload, readRecords } = await prepareReload();
    const target = { pluginId: "reload-proof", installHash: hashStableJson(record) };
    const request = { plugins: [target], acknowledgeCapabilities: { reviewToken } };
    await expect(reload(request)).rejects.toMatchObject({
      message:
        "Plugin reload-proof changed after the installation batch. Inspect it before reloading.",
    });
    const current = (await readRecords())?.[target.pluginId];
    expect(current?.acceptedSurfaceHash).toBe(reviewToken);
    expect(hashStableJson(current)).not.toBe(target.installHash);
    expect(request.plugins[0]?.installHash).toBe(hashStableJson(record));
    expect(applyRuntime).not.toHaveBeenCalled();
    await expect(
      reload({
        plugins: [{ pluginId: target.pluginId, installHash: hashStableJson(current) }],
      }),
    ).resolves.toMatchObject({ pluginIds: [target.pluginId], application: { generation: 1 } });
    expect(applyRuntime).toHaveBeenCalledOnce();
  });

  it.each(["transaction", "commit"] as const)(
    "preserves durable consent when reload authority is revoked at worker %s admission",
    async (stage) => {
      const { record, reviewToken, applyRuntime, reload, readRecords } = await prepareReload();
      const refused = new Error("plugin administrator authority revoked");
      let revoked = false;
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
              revoked = true;
            }
            admit(request, grant);
          }, attachment),
        );
      try {
        await expect(
          reload({
            plugins: [{ pluginId: "reload-proof" }],
            acknowledgeCapabilities: { reviewToken },
            beforePersistentApply() {
              if (revoked) {
                throw refused;
              }
            },
          }),
        ).rejects.toBe(refused);
      } finally {
        admission.mockRestore();
      }
      expect(revoked).toBe(true);
      expect((await readRecords())?.["reload-proof"]).toEqual(record);
      expect(applyRuntime).not.toHaveBeenCalled();
    },
  );

  it("stops a multi-target reload when another selected package needs a different review", async () => {
    const { reviewToken, applyRuntime, reload, readRecords } = await prepareReload(true);
    await expect(
      reload({
        plugins: [{ pluginId: "reload-proof" }, { pluginId: "second-proof" }],
        acknowledgeCapabilities: { reviewToken },
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "second-proof" } });
    const current = await readRecords();
    expect(current?.["reload-proof"]?.acceptedSurfaceHash).toBe(reviewToken);
    expect(current?.["second-proof"]?.acceptedSurface).toBeUndefined();
    expect(applyRuntime).not.toHaveBeenCalled();
  });
});
