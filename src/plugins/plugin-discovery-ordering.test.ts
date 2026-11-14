import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { discoverConfiguredPluginLoadPaths, discoverOpenClawPlugins } from "./discovery.js";
import { loadOpenClawPlugins } from "./loader.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const temp = createTempDirTracker();
const createTemporaryRoot = () => temp.make("openclaw-plugin-ordering-");
const isolatedEnv = (stateDir: string) => ({
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});
const discover = (env: NodeJS.ProcessEnv, extraPaths?: string[]) =>
  discoverOpenClawPlugins({ env, extraPaths, installRecords: {} });

function createPlugin(pluginRoot: string, id: string, bundledDist?: boolean) {
  writeTree(pluginRoot, {
    "package.json": {
      name: `@qa/${id}`,
      openclaw: { extensions: ["./index.cjs"], build: { bundledDist } },
    },
    "openclaw.plugin.json": { id, configSchema: { type: "object" } },
    "index.cjs":
      `module.exports = { id: "${id}", register(api) { ` +
      `api.on("gateway_start", () => {}); ` +
      `api.registerService({ id: "${id}-service", start() {} }); } };`,
  });
  return pluginRoot;
}

function createPlugins(root: string, bundledDist?: boolean) {
  return ["zeta", "alpha"].map((id) => createPlugin(path.join(root, id), id, bundledDist));
}

function reverseDirectoryEntries(directory: string): void {
  const readDirectory = fs.readdirSync;
  vi.spyOn(fs, "readdirSync").mockImplementation((entryPath, options) => {
    const entries = readDirectory.call(fs, entryPath, options);
    const reverse =
      path.resolve(String(entryPath)) === directory &&
      options &&
      typeof options === "object" &&
      "withFileTypes" in options &&
      options.withFileTypes;
    return reverse
      ? entries.toSorted((left, right) => String(right.name).localeCompare(String(left.name)))
      : entries;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  temp.cleanup();
});

it("keeps plugin, equal-priority hook, and service order independent of directory enumeration", () => {
  const stateRoot = createTemporaryRoot();
  const extensionRoot = path.join(stateRoot, "extensions");
  createPlugins(extensionRoot);
  reverseDirectoryEntries(extensionRoot);

  const registry = loadOpenClawPlugins({
    activate: false,
    cache: false,
    config: { plugins: { allow: ["alpha", "zeta"], slots: { memory: "none" } } },
    env: isolatedEnv(stateRoot),
  });

  expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["alpha", "zeta"]);
  expect(registry.typedHooks.map((hook) => hook.pluginId)).toEqual(["alpha", "zeta"]);
  expect(registry.services.map((service) => service.pluginId)).toEqual(["alpha", "zeta"]);
});

it("keeps configured load-path precedence under deterministic directory discovery", () => {
  const stateRoot = createTemporaryRoot();
  const discovery = discover(isolatedEnv(path.join(stateRoot, "state")), createPlugins(stateRoot));

  expect(discovery.candidates.map((candidate) => candidate.idHint)).toEqual(["zeta", "alpha"]);
});

it.each([false, true])(
  "keeps the first configured alias for each physical source (alias first: %s)",
  (aliasFirst) => {
    const stateRoot = createTemporaryRoot();
    const pluginRoot = createPlugin(path.join(stateRoot, "plugin"), "ordered-plugin");
    const aliasRoot = path.join(stateRoot, "alias");
    fs.symlinkSync(pluginRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const loadPaths = (aliasFirst ? [aliasRoot, pluginRoot] : [pluginRoot, aliasRoot]).map((root) =>
      path.join(root, "index.cjs"),
    );
    const env = isolatedEnv(path.join(stateRoot, "state"));
    const runtime = discover(env, loadPaths);
    const configured = discoverConfiguredPluginLoadPaths({ loadPaths, env, deduplicate: true });
    expect(runtime.candidates.map((candidate) => candidate.source)).toEqual([loadPaths[0]]);
    expect(configured.candidates).toEqual(runtime.candidates);
  },
);

it("keeps bundled dist-opt-out source plugin discovery deterministic", () => {
  const packageRoot = createTemporaryRoot();
  const sourceRoot = path.join(packageRoot, "extensions");
  const bundledRoot = path.join(packageRoot, "dist", "extensions");
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  fs.mkdirSync(bundledRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/fake.git");
  fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []");
  createPlugins(sourceRoot, false);
  reverseDirectoryEntries(sourceRoot);

  const discovery = discover({
    OPENCLAW_STATE_DIR: path.join(packageRoot, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  });

  expect(discovery.candidates.map((candidate) => candidate.idHint)).toEqual(["alpha", "zeta"]);
});

it("orders manifest-only plugin metadata consistently across filesystem enumeration", () => {
  const root = createTemporaryRoot();
  const home = path.join(root, "home");
  const extensionRoot = path.join(home, ".openclaw", "extensions");
  createPlugins(extensionRoot);
  reverseDirectoryEntries(extensionRoot);

  const records = listOpenClawPluginManifestMetadata({
    OPENCLAW_HOME: home,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "no-bundled-plugins"),
  });

  expect(
    records.filter((record) => record.origin === "global").map((record) => record.manifest.id),
  ).toEqual(["alpha", "zeta"]);
});
