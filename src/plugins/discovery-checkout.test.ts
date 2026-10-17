import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const checkout = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const tempDirs: string[] = [];
beforeEach(() => vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "0"));
afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTrackedTempDirs(tempDirs);
});

function makeDir(prefix: string) {
  return fs.realpathSync(makeTrackedTempDir(prefix, tempDirs));
}

function writePlugin(root: string, id: string, extension: string) {
  writeJsonFile(path.join(root, "package.json"), {
    name: `@openclaw/${id}`,
    openclaw: { extensions: [`./index.${extension}`] },
  });
  writeJsonFile(path.join(root, "openclaw.plugin.json"), { id, configSchema: { type: "object" } });
  fs.writeFileSync(path.join(root, `index.${extension}`), "export default {};\n");
}

function aliasPath(root: string, stateDir: string, alias: string) {
  const selected = alias.startsWith("symlink") ? path.join(stateDir, "linked-plugin") : root;
  if (selected !== root) {
    fs.symlinkSync(root, selected, process.platform === "win32" ? "junction" : "dir");
  }
  return alias.endsWith("directory") ? selected : path.join(selected, "index.ts");
}

function discoveryEnv(stateDir: string, bundledDir: string | undefined, realCheckout = true) {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DEV_SOURCE_ROOT: realCheckout ? checkout : undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: realCheckout ? "0" : "1",
  };
}

it.each(["default", "source"])(
  "selects the checkout %s tree over a tracked local copy without trusting unrelated plugins",
  (tree) => {
    const stateDir = makeDir("openclaw-checkout-shadow");
    const installRecords = Object.fromEntries(
      ["codex", "diffs", "unrelated"].map((id) => {
        const pluginDir = path.join(stateDir, "extensions", id);
        writePlugin(pluginDir, id, "js");
        return [id, { source: "path" as const, installPath: pluginDir, sourcePath: pluginDir }];
      }),
    );
    const env = discoveryEnv(
      stateDir,
      tree === "source" ? path.join(checkout, "extensions") : undefined,
    );
    withPluginCache(createPluginCache(), () => {
      const registry = loadPluginManifestRegistryCore({
        env,
        installRecords,
        candidates: discoverOpenClawPlugins({ env, installRecords }).candidates,
      });
      const selected = registry.plugins.find((plugin) => plugin.id === "codex");
      for (const [id, expected] of [
        [
          "codex",
          { origin: "bundled", rootDir: path.join(resolveBundledPluginsDir(env)!, "codex") },
        ],
        ["unrelated", { origin: "global", trustedOfficialInstall: undefined }],
        ["diffs", { origin: "bundled", rootDir: path.join(checkout, "extensions", "diffs") }],
      ] as const) {
        expect(registry.plugins.find((plugin) => plugin.id === id)).toMatchObject(expected);
      }
      const select = (paths: string[]) =>
        loadPluginManifestRegistryCore({
          env,
          installRecords,
          config: { plugins: { load: { paths } } },
        }).plugins.find((plugin) => plugin.id === "codex");
      const installed = installRecords.codex!.installPath;
      expect(select([installed])).toMatchObject({
        origin: "config",
        rootDir: installed,
        trustedOfficialInstall: undefined,
      });
      for (const aliasFirst of [true, false]) {
        const paths = [selected!.source, installed];
        expect(select(aliasFirst ? paths : paths.toReversed())).toMatchObject({
          origin: aliasFirst ? "bundled" : "config",
          source: aliasFirst ? selected!.source : path.join(installed, "index.js"),
        });
      }
    });
  },
);
const aliasShapes = ["direct directory", "symlink directory", "direct file", "symlink file"];
it.each(
  ["checkout", "built", "unbuilt"].flatMap((tree) =>
    aliasShapes
      .filter((alias) => tree === "checkout" || alias !== "symlink file")
      .flatMap((alias) =>
        (tree === "checkout" ? ["configured"] : ["configured", "installed"]).map((selection) => ({
          tree,
          alias,
          selection,
        })),
      ),
  ),
)("keeps $selection $alias aliases bundled in a $tree tree", ({ tree, alias, selection }) => {
  const realCheckout = tree === "checkout";
  const stateDir = makeDir("openclaw-host-provenance");
  const bundledDir = realCheckout
    ? path.join(checkout, "extensions")
    : makeDir("openclaw-bundled-tree");
  const id = realCheckout ? "codex" : "hosted";
  const pluginRoot = path.join(bundledDir, id);
  if (!realCheckout) {
    writePlugin(pluginRoot, id, "ts");
  }
  if (tree === "built") {
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n");
  }
  const selectedPath = aliasPath(pluginRoot, stateDir, alias);
  const aliasRoot = alias.endsWith("directory") ? selectedPath : path.dirname(selectedPath);
  const env = discoveryEnv(stateDir, bundledDir, realCheckout);
  withPluginCache(createPluginCache(), () => {
    const discovery = discoverOpenClawPlugins({
      env,
      extraPaths: selection === "configured" ? [selectedPath] : [],
      installRecords:
        selection === "installed"
          ? {
              [id]: {
                source: "path",
                sourcePath: aliasRoot,
                installPath: selectedPath,
              },
            }
          : {},
    });
    const source = path.join(pluginRoot, "index.ts");
    const expected = { origin: "bundled", rootDir: pluginRoot, source };
    // Synthetic trees must deduplicate aliases even when compiled output exists.
    if (!realCheckout) {
      expect(discovery.candidates.filter((candidate) => candidate.idHint === id)).toEqual([
        expect.objectContaining({
          ...expected,
          ...(selection === "configured" ? { configSelected: true } : {}),
        }),
      ]);
    }
    const registry = loadPluginManifestRegistryCore({
      env,
      candidates: discovery.candidates,
      installRecords: {},
    });
    expect(registry.plugins.find((plugin) => plugin.id === id)).toMatchObject(expected);
  });
});
