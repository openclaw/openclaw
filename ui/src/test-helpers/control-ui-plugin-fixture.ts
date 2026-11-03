import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { controlUiPluginAssetPrefix } from "../../../src/gateway/control-ui-plugin-assets-contract.js";
import { readPluginControlUiAssets } from "../../../src/plugins/control-ui-assets.js";
import type { PluginManifestControlUi } from "../../../src/plugins/manifest-types.js";
import { loadPluginManifest } from "../../../src/plugins/manifest.js";
import type { NativeControlUiPluginFixture } from "./control-ui-e2e-contract.ts";
import { defaultControlUiFeatureMethods } from "./control-ui-e2e-defaults.ts";
import {
  getSharedControlUiE2ePreview,
  type PreparedNativeControlUiPluginBuild,
} from "./control-ui-e2e-shared-preview.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-mock-scenario.ts";

const builds = new Map<string, Promise<PluginManifestControlUi>>();

/** Browser proofs load the same self-contained assets the plugin authoring command produces. */
export async function prepareNativeControlUiPluginFixtures(
  fixtures: readonly NativeControlUiPluginFixture[],
) {
  const plugins = [];
  const repositorySources = [];
  const preparedBuilds: PreparedNativeControlUiPluginBuild[] = [];
  const assets = new Map<string, { body: Buffer; contentType: string }>();
  for (const fixture of fixtures) {
    const key = `${fixture.rootDir}\0${fixture.source}`;
    let build = builds.get(key);
    if (!build) {
      const prepared = getSharedControlUiE2ePreview()?.nativePluginBuilds.find(
        (candidate) => candidate.rootDir === fixture.rootDir && candidate.source === fixture.source,
      );
      build = prepared
        ? Promise.resolve(prepared.declaration)
        : import("../../../src/cli/plugins-control-ui-build.js").then(({ buildPluginControlUi }) =>
            buildPluginControlUi(fixture),
          );
      builds.set(key, build);
    }
    const declaration = await build;
    const manifest = loadPluginManifest(fixture.rootDir);
    if (!manifest.ok) {
      throw new Error(manifest.error);
    }
    repositorySources.push(
      ...(manifest.manifest.repositorySources ?? []).map((source) =>
        Object.assign({ pluginId: fixture.pluginId }, source),
      ),
    );
    preparedBuilds.push({ rootDir: fixture.rootDir, source: fixture.source, declaration });
    const revision = path.basename(path.dirname(declaration.entry));
    const prefix = `${controlUiPluginAssetPrefix(fixture.pluginId)}${revision}/`;
    const generation = await readPluginControlUiAssets(fixture.rootDir, declaration);
    for (const [name, asset] of generation.assets) {
      assets.set(`${prefix}${name}`, asset);
    }
    plugins.push({
      pluginId: fixture.pluginId,
      name: fixture.pluginId,
      revision,
      entryUrl: `${prefix}${path.basename(declaration.entry)}`,
      ...(declaration.settingsViews ? { settingsViews: declaration.settingsViews } : {}),
      styles: (declaration.styles ?? []).map((file) => `${prefix}${path.basename(file)}`),
      ...(generation.panelIcon ? { panelIcon: generation.panelIcon.dataUrl } : {}),
    });
  }
  return {
    assets,
    preparedBuilds,
    catalog: {
      revision: plugins.map((entry) => entry.revision).join("-"),
      plugins,
      repositorySources,
      diagnostics: [],
      inlineViews: fixtures.flatMap((fixture) =>
        (fixture.inlineViews ?? []).map((view) => ({
          id: view.id,
          label: view.label,
          version: view.version,
          pluginId: fixture.pluginId,
        })),
      ),
    },
  };
}

export async function prepareControlUiMockGatewayScenario(
  scenario: ControlUiMockGatewayScenario = {},
) {
  const { catalog, assets } = await prepareNativeControlUiPluginFixtures(
    scenario.nativePlugins ?? [],
  );
  const suppliedCatalog = asNullableRecord(scenario.methodResponses?.["plugins.controlUi.list"]);
  const combinedCatalog = suppliedCatalog
    ? {
        ...catalog,
        ...suppliedCatalog,
        plugins: [
          ...catalog.plugins,
          ...(Array.isArray(suppliedCatalog.plugins) ? suppliedCatalog.plugins : []),
        ],
        repositorySources: [
          ...catalog.repositorySources,
          ...(Array.isArray(suppliedCatalog.repositorySources)
            ? suppliedCatalog.repositorySources
            : []),
        ],
      }
    : catalog;
  const preparedScenario = catalog.plugins.length
    ? {
        ...scenario,
        featureMethods: [
          ...new Set([
            ...(scenario.featureMethods ?? defaultControlUiFeatureMethods),
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ]),
        ],
        methodResponses: {
          ...scenario.methodResponses,
          "plugins.controlUi.list": combinedCatalog,
          "plugins.controlUi.report": { ok: true },
        },
      }
    : scenario;
  return { scenario: preparedScenario, assets };
}
