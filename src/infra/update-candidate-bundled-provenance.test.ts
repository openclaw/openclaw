import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as bundledMetadata from "../plugins/bundled-plugin-metadata.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import * as pluginCacheFiles from "../plugins/plugin-cache-files.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { prepareUpdateCandidatePlugins } from "./update-candidate-plugins.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

const writeJson = (directory: string, name: string, value: unknown) =>
  fs.writeFile(path.join(directory, name), JSON.stringify(value));
const entry = (generation: string) => `export default ${JSON.stringify(generation)};`;
type InstallRecords = Record<string, PluginInstallRecord>;
const pluginConfig = (installs: InstallRecords, paths?: string[]): OpenClawConfig => ({
  plugins: { installs, ...(paths ? { load: { paths } } : {}) },
});
const fileModes = (directory: string) =>
  Promise.all(
    [directory, path.join(directory, "index.js")].map(async (file) => (await fs.stat(file)).mode),
  );
const rehearsalEnv = () => ({
  ...process.env,
  OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
});
let root: string;
let cleanupRehearsal: (() => Promise<void>) | undefined;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-provenance-")));
  cleanupRehearsal = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await cleanupRehearsal?.();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeHost(directory: string, source: boolean | "git" = false) {
  await fs.mkdir(directory, { recursive: true });
  await writeJson(directory, "package.json", { name: "openclaw", type: "module" });
  if (source) {
    await fs.mkdir(path.join(directory, "src"));
    await fs.writeFile(path.join(directory, "pnpm-workspace.yaml"), "packages: []\n");
    if (source === "git") {
      await fs.writeFile(path.join(directory, ".git"), "");
    }
  }
}

function writeInstalledIndex(stateDir: string, installRecords: InstallRecords) {
  openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } })
    .db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    )
    .run("plugins.installedIndex", JSON.stringify({ revision: 1, index: { installRecords } }), 1);
  closeOpenClawStateDatabaseByPath(path.join(stateDir, "state", "openclaw.sqlite"));
}

async function rehearse(params: Parameters<typeof prepareUpdateCandidateRehearsal>[0]) {
  await materializeUpdateCandidateStateWorker(params.candidateRoot);
  const rehearsal = await prepareUpdateCandidateRehearsal({ env: rehearsalEnv(), ...params });
  cleanupRehearsal = rehearsal.cleanup;
  const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
  return { rehearsal, copied };
}

function inspectPlugins(stateDir: string, bundledRoot: string, config: OpenClawConfig) {
  return withPluginCache(
    createPluginCache(),
    () =>
      loadPluginManifestRegistryCore({
        env: {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        },
        config,
      }).plugins,
  );
}

async function writePlugin(
  directory: string,
  id: string,
  generation: string,
  names = ["index"],
  packageName = `@openclaw/${id}`,
) {
  await fs.mkdir(directory, { recursive: true });
  await writeJson(directory, "package.json", {
    name: packageName,
    version: "2026.9.3",
    type: "module",
    openclaw: { extensions: names.map((name) => `./${name}.js`) },
  });
  await writeJson(directory, "openclaw.plugin.json", { id, configSchema: { type: "object" } });
  await fs.writeFile(path.join(directory, "index.js"), entry(generation));
  for (const name of names.filter((entryName) => entryName !== "index")) {
    await fs.writeFile(path.join(directory, `${name}.js`), entry(`${generation}-${name}`));
  }
}

it.each([
  { kind: "directory", bundled: true },
  { kind: "source permissions", bundled: true },
  { kind: "symlink", bundled: true },
  { kind: "entrypoint", bundled: true },
  { kind: "renamed candidate directory", bundled: true },
  { kind: "split candidate runtime", bundled: true },
  { kind: "source checkout alongside built runtime", bundled: true },
  { kind: "candidate in-package fallback", bundled: true },
  { kind: "candidate escaping fallback", bundled: false },
  { kind: "candidate escaping fallback with external install", bundled: false },
  { kind: "source escaping fallback", bundled: false },
  { kind: "external path", bundled: false },
  { kind: "source symlink escapes bundled directory", bundled: false },
  { kind: "candidate symlink escapes bundled directory", bundled: false },
  { kind: "candidate bundled root escapes package", bundled: false },
  { kind: "missing candidate ID", bundled: false },
  { kind: "mismatched candidate ID", bundled: false },
  { kind: "missing source selection", bundled: false },
  { kind: "source package mismatch", bundled: false },
  { kind: "bundled plugins disabled", bundled: false },
])("preserves candidate plugin provenance: $kind", async ({ kind, bundled }) => {
  const sourceState = path.join(root, "source-state");
  const liveHost = path.join(root, "live-host");
  const candidateHost = path.join(root, "candidate-host");
  const liveBundled = path.join(liveHost, "extensions");
  const livePlugin = path.join(liveBundled, "demo");
  const sourceCheckout =
    kind === "source checkout alongside built runtime" || kind === "source escaping fallback";
  const sourceBundled = sourceCheckout ? path.join(liveHost, "dist", "extensions") : liveBundled;
  const candidateBundled = path.join(
    candidateHost,
    kind === "split candidate runtime" ? "dist-runtime" : "dist",
    "extensions",
  );
  const candidateFallback = kind.startsWith("candidate ") && kind.includes("fallback");
  const escapingFallback = kind.startsWith("candidate escaping fallback");
  const candidatePlugin = path.join(
    candidateFallback ? path.join(candidateHost, "extensions") : candidateBundled,
    kind === "renamed candidate directory" ? "renamed-demo" : "demo",
  );
  const externalInstall =
    kind === "external path" || kind === "candidate escaping fallback with external install";
  const sourceSymlink =
    kind === "source symlink escapes bundled directory" || kind === "source escaping fallback";
  const externalSource = externalInstall || sourceSymlink;
  const sourcePlugin = externalSource ? path.join(root, "external", "demo") : livePlugin;
  await writeHost(liveHost, true);
  await writeHost(candidateHost, candidateFallback ? "git" : false);
  await fs.mkdir(liveBundled, { recursive: true });
  await fs.mkdir(candidateBundled, { recursive: true });
  if (candidateFallback) {
    await writePlugin(path.join(candidateBundled, "another"), "another", "built candidate");
    if (escapingFallback) {
      const externalFallback = path.join(root, "external-fallback");
      await fs.mkdir(externalFallback);
      await fs.symlink(externalFallback, path.dirname(candidatePlugin), "junction");
    }
  }
  if (kind === "candidate bundled root escapes package") {
    const externalBundled = path.join(root, "external-bundled");
    await fs.mkdir(externalBundled);
    await fs.rmdir(candidateBundled);
    await fs.symlink(externalBundled, candidateBundled, "junction");
  }
  await writePlugin(sourcePlugin, "demo", "live");
  if (sourceCheckout) {
    await fs.writeFile(path.join(liveHost, ".git"), "");
    await writePlugin(path.join(sourceBundled, "another"), "another", "built live");
  }
  if (sourceSymlink) {
    if (sourceCheckout) {
      await fs.rmdir(liveBundled);
      await fs.symlink(path.dirname(sourcePlugin), liveBundled, "junction");
    } else {
      await fs.symlink(sourcePlugin, livePlugin, "junction");
    }
  } else if (externalInstall) {
    await writePlugin(livePlugin, "demo", "bundled live");
  }
  if (kind === "split candidate runtime") {
    await writePlugin(path.join(candidateHost, "dist", "extensions", "demo"), "demo", "unused");
  }
  if (kind === "candidate symlink escapes bundled directory") {
    const externalCandidate = path.join(root, "external-candidate", "demo");
    await writePlugin(externalCandidate, "demo", "candidate");
    await fs.symlink(externalCandidate, candidatePlugin, "junction");
  } else if (kind !== "missing candidate ID") {
    await writePlugin(
      candidatePlugin,
      kind === "mismatched candidate ID" ? "other" : "demo",
      "candidate",
    );
  }
  let locator = externalInstall ? sourcePlugin : livePlugin;
  if (kind === "symlink") {
    locator = path.join(root, "demo-alias");
    await fs.symlink(livePlugin, locator, "junction");
  } else if (kind === "entrypoint") {
    locator = path.join(livePlugin, "index.js");
  }
  const installRecords = {
    demo: { source: "path", installPath: locator, sourcePath: locator },
  } satisfies InstallRecords;
  const config = pluginConfig(installRecords, kind === "entrypoint" ? [locator] : undefined);
  writeInstalledIndex(sourceState, installRecords);
  if (kind === "source permissions" && process.platform !== "win32") {
    await fs.chmod(sourcePlugin, 0o777);
    await fs.chmod(path.join(sourcePlugin, "index.js"), 0o666);
  }
  const sourceModes = await fileModes(sourcePlugin);
  const outsideCandidate = kind === "candidate bundled root escapes package" || escapingFallback;
  if (outsideCandidate && process.platform !== "win32") {
    await fs.chmod(candidatePlugin, 0o777);
  }
  const candidateMode = outsideCandidate ? (await fs.stat(candidatePlugin)).mode : undefined;
  const sourceBundledPlugins = {
    packageRoot: kind === "source package mismatch" ? candidateHost : liveHost,
    directory: kind === "missing source selection" ? undefined : sourceBundled,
  };
  if (escapingFallback || kind === "source escaping fallback") {
    const metadata = vi.spyOn(bundledMetadata, "listBundledPluginMetadata");
    const directoryReads = vi.spyOn(pluginCacheFiles, "readPluginCacheDirectory");
    await withPluginCache(createPluginCache(), () =>
      prepareUpdateCandidatePlugins({
        config,
        stateDir: sourceState,
        targetStateDir: path.join(root, "copy"),
        candidateRoot: candidateHost,
        sourceBundledPlugins,
        env: rehearsalEnv(),
      }),
    );
    const fallback = escapingFallback ? path.dirname(candidatePlugin) : liveBundled;
    expect(directoryReads.mock.calls.map(([directory]) => directory)).not.toContain(fallback);
    expect(metadata.mock.calls.map(([options]) => options?.scanDir)).not.toContain(fallback);
    vi.restoreAllMocks();
  }
  const { rehearsal } = await rehearse({
    config,
    candidateRoot: candidateHost,
    sourceBundledPlugins,
    stateDir: sourceState,
    env: {
      ...rehearsalEnv(),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: kind === "bundled plugins disabled" ? "1" : undefined,
    },
  });
  if (candidateMode !== undefined) {
    expect((await fs.stat(candidatePlugin)).mode).toBe(candidateMode);
  }
  const candidate = inspectPlugins(rehearsal.stateDir, candidateBundled, {}).find(
    (plugin) => plugin.id === "demo",
  );
  expect(candidate).toMatchObject({
    origin: bundled ? "bundled" : "global",
    trust: { reason: bundled ? "bundled" : "origin-path", installSource: "path" },
  });
  const selectedEntry = candidate?.source ?? "";
  expect(await fs.readFile(selectedEntry, "utf8")).toBe(
    `export default ${JSON.stringify(bundled ? "candidate" : "live")};`,
  );
  if (bundled) {
    expect(selectedEntry).toBe(path.join(candidatePlugin, "index.js"));
    expect(rehearsal.snapshotCapacity.pluginBytes).toBe(0);
  } else {
    expect(selectedEntry.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
  }
  expect(await fileModes(sourcePlugin)).toEqual(sourceModes);
});

it.each([false, true])(
  "redirects multi-entry bundles with missing candidate entry=%s",
  async (missing) => {
    const sourceHost = path.join(root, "source-host");
    const candidateHost = path.join(root, "candidate-host");
    const sourcePlugin = path.join(sourceHost, "extensions", "demo");
    const candidatePlugin = path.join(candidateHost, "dist", "extensions", "demo");
    const stateDir = path.join(root, "state");
    const entries = ["first", "second", "third"];
    const candidateEntries = missing ? entries.slice(0, 2) : entries;
    await writeHost(sourceHost, true);
    await writeHost(candidateHost);
    for (const [directory, names, generation] of [
      [sourcePlugin, entries, "live"],
      [candidatePlugin, candidateEntries, "candidate"],
    ] as const) {
      await writePlugin(directory, "demo", generation, names, "@openclaw/different-package-name");
    }
    const installRecords: InstallRecords = missing
      ? Object.fromEntries(
          entries.map((name) => [
            `demo/${name}`,
            { source: "path", installPath: path.join(sourcePlugin, `${name}.js`) },
          ]),
        )
      : { demo: { source: "path", installPath: sourcePlugin } };
    const config = pluginConfig(
      installRecords,
      missing ? undefined : entries.map((name) => path.join(sourcePlugin, `${name}.js`)),
    );
    writeInstalledIndex(stateDir, installRecords);
    const { rehearsal, copied } = await rehearse({
      config,
      stateDir,
      candidateRoot: candidateHost,
      sourceBundledPlugins: { packageRoot: sourceHost, directory: path.dirname(sourcePlugin) },
    });
    const projectedPaths = entries.map((name, index) =>
      missing
        ? copied.plugins?.installs?.[`demo/${name}`]?.installPath
        : copied.plugins?.load?.paths?.[index],
    );
    for (const [index, name] of candidateEntries.entries()) {
      expect(projectedPaths[index]).toBe(path.join(candidatePlugin, `${name}.js`));
    }
    if (!missing) {
      expect(copied.plugins?.installs?.demo?.installPath).toBe(candidatePlugin);
    }
    const discovered = inspectPlugins(rehearsal.stateDir, path.dirname(candidatePlugin), copied);
    for (const name of candidateEntries) {
      expect(discovered.find((plugin) => plugin.id === `demo/${name}`)).toMatchObject({
        origin: "bundled",
        source: path.join(candidatePlugin, `${name}.js`),
        trust: { reason: "bundled" },
      });
    }
    if (missing) {
      const retained = projectedPaths[2] ?? "";
      expect(retained.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
      expect(await fs.readFile(retained, "utf8")).toBe('export default "live-third";');
      expect(discovered.find((plugin) => plugin.source === retained)).toMatchObject({
        origin: "global",
        trust: { reason: "origin-path" },
      });
    }
  },
);
