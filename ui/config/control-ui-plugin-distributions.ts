import fs from "node:fs";
import path from "node:path";
import { normalizePath, type Plugin } from "vite";
import { validatePluginUiCapabilities } from "../../packages/gateway-protocol/src/plugin-ui-capabilities.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { collectSourceCheckoutPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  pluginControlUiGenerationHash,
  pluginControlUiRevision,
  readPluginControlUiAssets,
} from "../../src/plugins/control-ui-assets.js";
import {
  controlUiSource,
  normalizeManifestControlUi,
} from "../../src/plugins/manifest-control-ui.js";
import type { ControlUiPluginDistribution } from "../src/plugins/control-ui-distribution.ts";

/** Consume only the completed canonical distribution, never source manifests or live plugins. */
export function controlUiPluginDistributionsPlugin(repoRoot: string, inputs: Set<string>): Plugin {
  const inventoryModule = normalizePath(
    path.join(repoRoot, "ui/src/plugins/control-ui-distribution.ts"),
  );
  let source = "";
  return {
    name: "control-ui-plugin-distributions",
    apply: "build",
    async buildStart() {
      const directory = path.join(repoRoot, "dist/extensions");
      const required = process.env.OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS === "1";
      const promised = required
        ? collectSourceCheckoutPluginBuildEntries({ cwd: repoRoot })
            .filter(
              (entry) =>
                !entry.isolated &&
                isRecord(entry.packageJson) &&
                controlUiSource(entry.packageJson),
            )
            .map((entry) => entry.id)
        : [];
      const entries = fs.existsSync(directory)
        ? fs
            .readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [];
      const captured = new Set<string>();
      const modules: string[] = [];
      const consume = (file: string) => {
        this.addWatchFile(file);
        inputs.add(file);
      };
      for (const id of entries.toSorted()) {
        const rootDir = path.join(directory, id);
        const manifestPath = path.join(rootDir, "openclaw.plugin.json");
        if (!fs.existsSync(manifestPath)) {
          continue;
        }
        const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const pluginId = isRecord(manifest) ? normalizeOptionalString(manifest.id) : undefined;
        if (!isRecord(manifest) || !pluginId) {
          throw new Error(`Invalid packaged plugin manifest for ${id}: missing plugin id`);
        }
        const result = normalizeManifestControlUi(manifest.controlUi);
        if (!result.ok) {
          throw new Error(`Invalid packaged plugin manifest for ${id}: ${result.error}`);
        }
        const controlUi = result.value;
        if (!controlUi) {
          continue;
        }
        const capabilities = validatePluginUiCapabilities(manifest.uiCapabilities);
        const uiCapabilities = capabilities.ok ? capabilities.capabilities : undefined;
        const packagePath = path.join(rootDir, "package.json");
        const pkg: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        if (
          !isRecord(pkg) ||
          typeof pkg.name !== "string" ||
          !pkg.name ||
          typeof pkg.version !== "string" ||
          !pkg.version
        ) {
          throw new Error(`Packaged native UI ${id} requires package identity`);
        }
        consume(manifestPath);
        consume(packagePath);
        const build = await readPluginControlUiAssets(rootDir, controlUi, {
          rejectHardlinks: false,
        });
        const generation = pluginControlUiGenerationHash(
          [...build.assets].map(([name, asset]) => ({ name, contents: asset.body })),
        );
        if (build.directory !== `dist/control-ui/${generation}`) {
          throw new Error(`Incomplete or invalid packaged native UI generation for ${id}`);
        }
        const revision = pluginControlUiRevision(controlUi, uiCapabilities, build.assets);
        const urls = new Map<string, string>();
        for (const [name, asset] of build.assets) {
          consume(path.join(rootDir, build.directory, name));
          const ref = this.emitFile({
            type: "asset",
            fileName: `assets/plugins/${encodeURIComponent(pluginId)}/${revision}/${name}`,
            source: asset.body,
          });
          urls.set(name, `import.meta.ROLLUP_FILE_URL_${ref}`);
        }
        const metadata: Pick<
          ControlUiPluginDistribution,
          "pluginId" | "revision" | "bundledDistribution"
        > = {
          pluginId,
          revision,
          bundledDistribution: { packageName: pkg.name, packageVersion: pkg.version },
        };
        modules.push(
          `{...${JSON.stringify(metadata)},entry:${urls.get(build.entryName)},styles:[${build.styles.map((name) => urls.get(name)).join(",")}],imports:[]}`,
        );
        captured.add(id);
      }
      for (const id of promised) {
        if (!captured.has(id)) {
          throw new Error(
            `Missing packaged native UI assets for ${id}; finish runtime-postbuild before building the UI`,
          );
        }
      }
      source = `export const controlUiPluginDistributions = [${modules.join(",")}];`;
    },
    transform(_code, id) {
      return id.split("?")[0] === inventoryModule ? { code: source, map: null } : null;
    },
  };
}
