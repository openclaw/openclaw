import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearBundledDiscoveryModeMemo } from "../../plugins/bundled-discovery-state.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  createSyncSuiteTempRootTracker,
  mkdirSafeDir,
} from "../../plugins/test-helpers/fs-fixtures.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnv } from "../../test-utils/env.js";
import { loadStaticManifestCatalogRowsForList } from "./list.manifest-catalog.js";

const tempRoots = createSyncSuiteTempRootTracker("manifest-catalog");
const url = (host: string) => `https://${host}.example.invalid/v1`;
const refs = (...providers: string[]) => providers.map((provider) => `${provider}/tiny-model`);
const expectedRow = (provider: string, alias = false) => ({
  ref: refs(provider)[0],
  api: alias ? "openai-responses" : "openai-completions",
  baseUrl: url(alias ? "alias" : "canonical"),
});

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
  tempRoots.cleanup();
});

function prepareFixture() {
  const root = fs.realpathSync(tempRoots.makeTempDir());
  const bundled = path.join(root, "bundled");
  const workspaceDir = path.join(root, "workspace");
  // The same-name convention must beat the competing alias.
  const aliases = {
    direct: { provider: "provider", baseUrl: url("competing") },
    alias: { provider: "provider", api: "openai-responses", baseUrl: url("alias") },
  };
  const fixtures = (
    [
      ["catalog-owner", "provider", bundled, "static"],
      ["direct", "direct", bundled, "static"],
      ["disabled-owner", "disabled", bundled, "static"],
      ["refreshable-owner", "refreshable", bundled, "refreshable"],
      ["runtime-owner", "runtime", bundled, "runtime"],
      ["workspace-owner", "workspace", path.join(workspaceDir, ".openclaw/extensions"), "static"],
    ] as const
  ).map(([pluginId, providerId, parent, discovery]) => {
    const rootDir = path.join(parent, pluginId);
    mkdirSafeDir(rootDir);
    return createColdPluginFixture({
      rootDir,
      pluginId,
      providerId,
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        modelCatalog: {
          providers: {
            [providerId]: {
              api: "openai-completions",
              baseUrl: url("canonical"),
              models: [{ id: "tiny-model", name: "Tiny model", contextWindow: 8192 }],
            },
          },
          discovery: { [providerId]: discovery },
          aliases: pluginId === "catalog-owner" ? aliases : undefined,
        },
      },
    });
  });
  const cfg: OpenClawConfig = {
    models: { catalogRefresh: { enabled: false } },
    plugins: {
      entries: Object.fromEntries(
        fixtures.map(({ pluginId }) => [pluginId, { enabled: pluginId !== "disabled-owner" }]),
      ),
    },
  };
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "state/openclaw.json"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    VITEST: "true",
  };
  const metadataSnapshot = loadPluginMetadataSnapshot({
    config: cfg,
    env,
    workspaceDir,
    allowCurrent: false,
    preferPersisted: false,
  });
  const manifests = new Set(fixtures.map((f) => path.join(f.rootDir, "openclaw.plugin.json")));
  function readRows(providerFilter?: string, config = cfg) {
    const opens = vi.spyOn(fs, "openSync");
    const reads = vi.spyOn(fs, "readFileSync");
    const isManifest = (file: unknown) =>
      manifests.has(file instanceof URL ? fileURLToPath(file) : String(file));
    const output = loadStaticManifestCatalogRowsForList({
      cfg: config,
      env,
      metadataSnapshot,
      providerFilter,
    });
    expect(fixtures.some(isColdPluginRuntimeLoaded)).toBe(false);
    // Forbidding manifest opens also catches reads through newly pinned descriptors.
    expect.soft(opens.mock.calls.filter(([file]) => isManifest(file))).toEqual([]);
    expect.soft(reads.mock.calls.filter(([file]) => isManifest(file))).toEqual([]);
    return output;
  }
  return { cfg, env, workspaceDir, metadataSnapshot, readRows };
}

it("uses the explicit profile's allowlist instead of process compatibility policy", () => {
  const { cfg: baseConfig, env, workspaceDir, readRows } = prepareFixture();
  const processEnv = { OPENCLAW_STATE_DIR: path.join(workspaceDir, "other-profile") };
  writeConfigMachineState("plugins.bundledDiscovery", "allowlist", { env });
  writeConfigMachineState("plugins.bundledDiscovery", "compat", { env: processEnv });
  clearBundledDiscoveryModeMemo();
  const cfg: OpenClawConfig = {
    ...baseConfig,
    plugins: { ...baseConfig.plugins, allow: ["unrelated-owner"] },
  };
  withEnv(processEnv, () =>
    ["direct", "alias"].forEach((provider) => expect.soft(readRows(provider, cfg)).toEqual([])),
  );
});

it("keeps captured static provider and alias rows after manifest removal without I/O", () => {
  const { cfg, env, metadataSnapshot, readRows } = prepareFixture();
  const coldRows = withEnv(env, () => loadStaticManifestCatalogRowsForList({ cfg }));
  expect(coldRows.map((row) => row.ref)).toEqual(refs("direct", "disabled", "provider"));

  for (const providerFilter of [" PROVIDER ", " ALIAS ", "direct", "disabled"]) {
    const provider = providerFilter.trim().toLowerCase();
    expect(readRows(providerFilter)).toMatchObject(
      provider === "disabled" ? [] : [expectedRow(provider, provider === "alias")],
    );
  }
  const owner = metadataSnapshot.byPluginId.get("catalog-owner");
  assert(owner, "missing fixture catalog owner");
  fs.unlinkSync(owner.manifestPath);
  expect(readRows("alias").map((row) => row.ref)).toEqual(refs("alias"));
  expect(readRows().map((row) => row.ref)).toEqual(
    refs("direct", "disabled", "provider", "workspace"),
  );
});
