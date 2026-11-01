import path from "node:path";
import { controlUiPluginAssetPrefix } from "../../../src/gateway/control-ui-plugin-assets-contract.js";
import { readPluginControlUiAssets } from "../../../src/plugins/control-ui-assets.js";
import type { PluginManifestControlUi } from "../../../src/plugins/manifest-types.js";
import {
  getSharedControlUiE2ePreview,
  type PreparedNativeControlUiPluginBuild,
} from "./control-ui-e2e-shared-preview.ts";

export type NativeControlUiPluginFixture = {
  pluginId: string;
  rootDir: string;
  source: string;
  inlineViews?: readonly { id: string; label: string; version: number }[];
};

const builds = new Map<string, Promise<PluginManifestControlUi>>();

/** Browser proofs load the same self-contained assets the plugin authoring command produces. */
export async function prepareNativeControlUiPluginFixtures(
  fixtures: readonly NativeControlUiPluginFixture[],
) {
  const plugins = [];
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
      styles: (declaration.styles ?? []).map((file) => `${prefix}${path.basename(file)}`),
    });
  }
  return {
    assets,
    preparedBuilds,
    catalog: {
      revision: plugins.map((entry) => entry.revision).join("-"),
      plugins,
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
