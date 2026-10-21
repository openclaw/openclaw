import fs from "node:fs";
import path from "node:path";
import { normalizePath, type Plugin } from "vite";
import { validatePluginUiCapabilities } from "../../packages/gateway-protocol/src/plugin-ui-capabilities.js";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { collectSourceCheckoutPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { prepareControlUiSettings } from "../../scripts/lib/prepare-control-ui-settings.mts";
import {
  pluginControlUiGenerationHash,
  pluginControlUiRevision,
  readPluginControlUiAssets,
  type PluginControlUiAsset,
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
  let serving = false;
  let base = "/";
  const servedAssets = new Map<string, PluginControlUiAsset>();
  return {
    name: "control-ui-plugin-distributions",
    configResolved(config) {
      serving = config.command === "serve";
      base = config.base === "./" ? "/" : config.base;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const asset = servedAssets.get((req.url ?? "").split("?")[0]!);
        if (!asset || (req.method !== "GET" && req.method !== "HEAD")) {
          next();
          return;
        }
        res.setHeader("Content-Type", asset.contentType);
        res.setHeader("Content-Length", asset.body.length);
        res.setHeader("Cache-Control", "no-cache");
        res.end(req.method === "HEAD" ? undefined : asset.body);
      });
    },
    async buildStart() {
      // The build wrapper prepares before hashing cache inputs; other entry points own preparation.
      if (
        serving ||
        this.meta.watchMode ||
        process.env.OPENCLAW_CONTROL_UI_PREPARED_SETTINGS_ROOT !== repoRoot
      ) {
        await prepareControlUiSettings(repoRoot);
      }
      const directory = path.join(repoRoot, "dist/extensions");
      const required = process.env.OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS === "1";
      const promised = required
        ? collectSourceCheckoutPluginBuildEntries({ cwd: repoRoot })
            .filter((entry) => {
              if (!isRecord(entry.packageJson) || !controlUiSource(entry.packageJson)) {
                return false;
              }
              if (!entry.isolated) {
                return true;
              }
              const manifest = JSON.parse(
                fs.readFileSync(
                  path.join(repoRoot, "extensions", entry.id, "openclaw.plugin.json"),
                  "utf8",
                ),
              );
              const declaration = normalizeManifestControlUi(manifest.controlUi, manifest.channels);
              if (!declaration.ok) {
                throw new Error(
                  `Invalid Control UI declaration for ${entry.id}: ${declaration.error}`,
                );
              }
              return Boolean(declaration.value?.settingsViews?.length);
            })
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
        const result = normalizeManifestControlUi(manifest.controlUi, manifest.channels);
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
          const fileName = `assets/plugins/${encodeURIComponent(pluginId)}/${revision}/${name}`;
          if (serving) {
            const url = `${base}${fileName}`;
            servedAssets.set(url, asset);
            urls.set(name, JSON.stringify(url));
          } else {
            const ref = this.emitFile({ type: "asset", fileName, source: asset.body });
            urls.set(name, `import.meta.ROLLUP_FILE_URL_${ref}`);
          }
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
          `{...${JSON.stringify({ ...metadata, activation: controlUi.activation, settingsViews: controlUi.settingsViews })},entry:${urls.get(build.entryName)},styles:[${build.styles.map((name) => urls.get(name)).join(",")}],imports:[]}`,
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
    transform: {
      filter: { id: /\/ui\/src\/plugins\/control-ui-distribution\.ts(?:\?.*)?$/ },
      handler(_code, id) {
        return id.split("?")[0] === inventoryModule ? { code: source, map: null } : null;
      },
    },
  };
}
