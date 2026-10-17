import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  fs.mkdirSync(root, { recursive: true });
  const files = {
    "package.json": JSON.stringify({
      name: `@openclaw/${id}`,
      openclaw: { extensions: [`./index.${extension}`] },
    }),
    "openclaw.plugin.json": JSON.stringify({ id, configSchema: { type: "object" } }),
    [`index.${extension}`]: "export default {};\n",
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
}

function aliasPath(root: string, stateDir: string, alias: string) {
  const selected = alias.startsWith("symlink") ? path.join(stateDir, "linked-plugin") : root;
  if (selected !== root) {
    fs.symlinkSync(root, selected, process.platform === "win32" ? "junction" : "dir");
  }
  return alias.endsWith("directory") ? selected : path.join(selected, "index.ts");
}

function discoveryEnv(stateDir: string, bundledDir: string | undefined, trust = "0") {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DEV_SOURCE_ROOT: checkout,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: trust,
  };
}

function registryFor(params: Parameters<typeof discoverOpenClawPlugins>[0]) {
  const discovery = discoverOpenClawPlugins(params);
  const registry = loadPluginManifestRegistryCore({ ...params, candidates: discovery.candidates });
  return { discovery, registry };
}

describe("running checkout discovery", () => {
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
        const { registry } = registryFor({ env, installRecords });
        const expectedRoot = path.join(resolveBundledPluginsDir(env)!, "codex");
        const selected = registry.plugins.find((plugin) => plugin.id === "codex");
        expect(selected).toMatchObject({
          origin: "bundled",
          rootDir: expectedRoot,
        });
        expect(registry.plugins.find((plugin) => plugin.id === "unrelated")).toMatchObject({
          origin: "global",
          trustedOfficialInstall: undefined,
        });
        expect(registry.plugins.find((plugin) => plugin.id === "diffs")).toMatchObject({
          origin: "bundled",
          rootDir: path.join(checkout, "extensions", "diffs"),
        });
        const overridden = loadPluginManifestRegistryCore({
          env,
          installRecords,
          config: { plugins: { load: { paths: [installRecords.codex!.installPath] } } },
        });
        expect(overridden.plugins.find((plugin) => plugin.id === "codex")).toMatchObject({
          origin: "config",
          rootDir: installRecords.codex!.installPath,
          trustedOfficialInstall: undefined,
        });
        for (const aliasFirst of [true, false]) {
          const paths = [selected!.source, installRecords.codex!.installPath];
          const ordered = loadPluginManifestRegistryCore({
            env,
            installRecords,
            config: { plugins: { load: { paths: aliasFirst ? paths : paths.toReversed() } } },
          });
          expect(ordered.plugins.find((plugin) => plugin.id === "codex")).toMatchObject({
            origin: aliasFirst ? "bundled" : "config",
            source: aliasFirst
              ? selected!.source
              : path.join(installRecords.codex!.installPath, "index.js"),
          });
        }
      });
    },
  );

  it.each(["direct file", "symlink file", "direct directory", "symlink directory"])(
    "retains host provenance for a %s configured alias of a bundled entry",
    (alias) => {
      const stateDir = makeDir("openclaw-checkout");
      const sourceRoot = path.join(checkout, "extensions");
      const pluginRoot = path.join(sourceRoot, "codex");
      const selectedPath = aliasPath(pluginRoot, stateDir, alias);
      const env = discoveryEnv(stateDir, sourceRoot);
      withPluginCache(createPluginCache(), () => {
        const { registry } = registryFor({
          env,
          extraPaths: [selectedPath],
          installRecords: {},
        });
        // Never keyed on whether the checkout happens to be built: the alias must
        // resolve exactly what the bundled scan resolves in either state.
        expect(registry.plugins.find((plugin) => plugin.id === "codex")).toMatchObject({
          origin: "bundled",
          rootDir: pluginRoot,
          source: path.join(pluginRoot, "index.ts"),
        });
      });
    },
  );
});

describe("host provenance across bundled build states", () => {
  // The checkout may or may not be built, so the invariant guard cannot depend on
  // it: a configured alias of a host-owned plugin must classify identically
  // whether the entry resolves to the TypeScript source or to compiled output.
  const aliasShapes = ["direct directory", "symlink directory", "direct file"] as const;
  const buildStates = [
    { label: "built", built: true },
    { label: "unbuilt", built: false },
  ] as const;

  it.each(
    buildStates.flatMap(({ label, built }) =>
      aliasShapes.flatMap((alias) =>
        ["configured", "installed"].map((selection) => ({ label, built, alias, selection })),
      ),
    ),
  )(
    "keeps $selection $alias aliases bundled in a $label bundled tree",
    ({ built, alias, selection }) => {
      const stateDir = makeDir("openclaw-host-provenance");
      const bundledDir = makeDir("openclaw-bundled-tree");
      const pluginRoot = path.join(bundledDir, "hosted");
      writePlugin(pluginRoot, "hosted", "ts");
      if (built) {
        fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
        fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n");
      }
      const selectedPath = aliasPath(pluginRoot, stateDir, alias);
      const aliasRoot = alias.endsWith("directory") ? selectedPath : path.dirname(selectedPath);
      const env = {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      };
      withPluginCache(createPluginCache(), () => {
        const discovery = discoverOpenClawPlugins({
          env,
          extraPaths: selection === "configured" ? [selectedPath] : [],
          installRecords:
            selection === "installed"
              ? {
                  hosted: {
                    source: "path",
                    sourcePath: aliasRoot,
                    installPath: selectedPath,
                  },
                }
              : {},
        });
        // One physical plugin must yield one candidate; a second candidate means the
        // alias resolved a different entry point than the bundled scan did.
        expect(discovery.candidates.filter((candidate) => candidate.idHint === "hosted")).toEqual([
          expect.objectContaining({
            origin: "bundled",
            rootDir: pluginRoot,
            source: path.join(pluginRoot, "index.ts"),
            ...(selection === "configured" ? { configSelected: true } : {}),
          }),
        ]);
        const registry = loadPluginManifestRegistryCore({
          env,
          candidates: discovery.candidates,
          installRecords: {},
        });
        expect(registry.plugins.find((plugin) => plugin.id === "hosted")).toMatchObject({
          origin: "bundled",
          rootDir: pluginRoot,
          source: path.join(pluginRoot, "index.ts"),
        });
      });
    },
  );
});
