import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const declarations = [
    ["catalog-owner", "fixture-provider", bundled, "static"],
    ["fixture-direct", "fixture-direct", bundled, "static"],
    ["disabled-owner", "fixture-disabled", bundled, "static"],
    ["refreshable-owner", "fixture-refreshable", bundled, "refreshable"],
    ["runtime-owner", "fixture-runtime", bundled, "runtime"],
    [
      "workspace-owner",
      "fixture-workspace",
      path.join(workspaceDir, ".openclaw/extensions"),
      "static",
    ],
  ] as const;
  const fixtures = declarations.map(([pluginId, providerId, parent, discovery]) => {
    const rootDir = path.join(parent, pluginId);
    mkdirSafeDir(rootDir);
    return createColdPluginFixture({
      rootDir,
      pluginId,
      providerId,
      packageName: `@example/${pluginId}`,
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        modelCatalog: {
          providers: {
            [providerId]: {
              api: "openai-completions",
              baseUrl: "https://canonical.example.invalid/v1",
              models: [{ id: "tiny-model", name: "Tiny model", contextWindow: 8192 }],
            },
          },
          discovery: { [providerId]: discovery },
          ...(pluginId === "catalog-owner"
            ? {
                aliases: {
                  // A competing declaration must not displace same-name convention rows.
                  "fixture-direct": {
                    provider: providerId,
                    baseUrl: "https://competing.example.invalid/v1",
                  },
                  "fixture-alias": {
                    provider: providerId,
                    api: "openai-responses",
                    baseUrl: "https://alias.example.invalid/v1",
                  },
                },
              }
            : {}),
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
  const manifestPaths = fixtures.map((fixture) =>
    path.join(fixture.rootDir, "openclaw.plugin.json"),
  );
  return { cfg, env, workspaceDir, metadataSnapshot, fixtures, manifestPaths };
}

function withoutManifestIo<T>(fixture: ReturnType<typeof prepareFixture>, run: () => T) {
  const opens = vi.spyOn(fs, "openSync");
  const reads = vi.spyOn(fs, "readFileSync");
  const isManifest = (file: unknown) =>
    fixture.manifestPaths.includes(file instanceof URL ? fileURLToPath(file) : String(file));
  try {
    const output = run();
    expect(fixture.fixtures.some(isColdPluginRuntimeLoaded)).toBe(false);
    // Forbidding manifest opens also catches reads through newly pinned descriptors.
    expect.soft(opens.mock.calls.filter(([file]) => isManifest(file))).toEqual([]);
    expect.soft(reads.mock.calls.filter(([file]) => isManifest(file))).toEqual([]);
    return output;
  } finally {
    opens.mockRestore();
    reads.mockRestore();
  }
}

describe("setup prepared manifest snapshot", () => {
  it("uses the explicit profile's allowlist instead of process compatibility policy", () => {
    const fixture = prepareFixture();
    const processEnv = { OPENCLAW_STATE_DIR: path.join(fixture.workspaceDir, "other-profile") };
    writeConfigMachineState("plugins.bundledDiscovery", "allowlist", { env: fixture.env });
    writeConfigMachineState("plugins.bundledDiscovery", "compat", { env: processEnv });
    clearBundledDiscoveryModeMemo();
    const cfg: OpenClawConfig = {
      ...fixture.cfg,
      plugins: { ...fixture.cfg.plugins, allow: ["unrelated-owner"] },
    };
    withEnv(processEnv, () =>
      withoutManifestIo(fixture, () => {
        for (const providerFilter of ["fixture-direct", "fixture-alias"]) {
          expect
            .soft(loadStaticManifestCatalogRowsForList({ ...fixture, cfg, providerFilter }))
            .toEqual([]);
        }
      }),
    );
  });

  it("keeps captured static provider and alias rows after manifest removal without I/O", () => {
    const fixture = prepareFixture();
    const coldRows = withEnv(fixture.env, () =>
      loadStaticManifestCatalogRowsForList({ cfg: fixture.cfg }),
    );
    expect(coldRows.map((row) => row.ref)).toEqual([
      "fixture-direct/tiny-model",
      "fixture-disabled/tiny-model",
      "fixture-provider/tiny-model",
    ]);

    for (const providerFilter of [
      " FIXTURE-PROVIDER ",
      " FIXTURE-ALIAS ",
      "fixture-direct",
      "fixture-disabled",
    ]) {
      const rows = withoutManifestIo(fixture, () =>
        loadStaticManifestCatalogRowsForList({ ...fixture, providerFilter }).map(
          ({ ref, api, baseUrl }) => ({ ref, api, baseUrl }),
        ),
      );
      const provider = providerFilter.trim().toLowerCase();
      expect(rows).toEqual(
        provider === "fixture-disabled"
          ? []
          : [
              {
                ref: `${provider}/tiny-model`,
                api: provider === "fixture-alias" ? "openai-responses" : "openai-completions",
                baseUrl: `https://${provider === "fixture-alias" ? "alias" : "canonical"}.example.invalid/v1`,
              },
            ],
      );
    }
    const owner = fixture.metadataSnapshot.byPluginId.get("catalog-owner");
    if (!owner) {
      throw new Error("missing fixture catalog owner");
    }
    fs.unlinkSync(owner.manifestPath);
    withoutManifestIo(fixture, () => {
      expect(
        loadStaticManifestCatalogRowsForList({ ...fixture, providerFilter: "fixture-alias" }).map(
          (row) => row.ref,
        ),
      ).toEqual(["fixture-alias/tiny-model"]);
      expect(loadStaticManifestCatalogRowsForList(fixture).map((row) => row.ref)).toEqual([
        "fixture-direct/tiny-model",
        "fixture-disabled/tiny-model",
        "fixture-provider/tiny-model",
        "fixture-workspace/tiny-model",
      ]);
    });
  });
});
