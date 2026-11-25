import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { fingerprintPluginRuntimeArtifact } from "./plugin-runtime-artifact-identity.js";
import { resolvePluginRuntimeArtifact } from "./plugin-runtime-artifact-resolution.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginChannelRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";

const tempDirs: string[] = [];

const pluginConfig = (enabled = true) => ({
  plugins: { allow: ["fixture"], entries: { fixture: { enabled } } },
});
const fixtureConfig = pluginConfig();
const emptyPlugin = "export default { register() {} };\n";
const configSchema = { type: "object", additionalProperties: false, properties: {} };
type ResolutionOptions = Partial<Parameters<typeof resolvePluginRuntimeArtifact>[0]>;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function writeJson(file: string, value: unknown) {
  return write(file, JSON.stringify(value));
}

function expectLoaded(registry: ReturnType<typeof loadFixture>, fields: Record<string, string>) {
  expect(registry.plugins).toContainEqual(
    expect.objectContaining({ id: "fixture", status: "loaded", ...fields }),
  );
}

function tempRoot() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-runtime-artifact-")),
  );
  tempDirs.push(root);
  return root;
}

function createBundledPluginFixture(builtExtension = ".js", providers?: string[]) {
  const packageRoot = tempRoot();
  const rootDir = path.join(packageRoot, "extensions", "fixture");
  const source = path.join(rootDir, "index.ts");
  const builtRoot = path.join(packageRoot, "dist/extensions/fixture");
  const builtSource = path.join(builtRoot, `index${builtExtension}`);
  write(source, emptyPlugin);
  write(builtSource, 'module.exports = { id: "fixture", register() {} };\n');
  writeJson(path.join(builtRoot, "package.json"), {
    openclaw: { extensions: [`./index${builtExtension}`], build: { runtimeFormat: "cjs" } },
  });
  writeJson(path.join(rootDir, "openclaw.plugin.json"), { id: "fixture", configSchema, providers });
  const artifact = { rootDir: fs.realpathSync(rootDir), source: fs.realpathSync(source) };
  return {
    ...artifact,
    packageRoot,
    builtRoot,
    builtSource: fs.realpathSync(builtSource),
    resolve(preferBuiltPluginArtifacts = false, options: ResolutionOptions = {}) {
      return resolveFixture({ ...artifact, preferBuiltPluginArtifacts, ...options });
    },
    withEnv<T>(run: () => T, extra: Record<string, string | undefined> = {}) {
      return withEnv(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(rootDir),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          ...extra,
        },
        run,
      );
    },
  };
}

function resolveFixture(params: ResolutionOptions & { source: string; rootDir: string }) {
  return resolvePluginRuntimeArtifact({
    pluginId: "fixture",
    entryKind: "runtime",
    origin: "bundled",
    preferBuiltPluginArtifacts: false,
    ...params,
  });
}

function withStagingRegistry<T>(
  options: Parameters<typeof resolvePluginRuntimeLoadContext>[0],
  run: () => T,
) {
  const registry = createEmptyPluginRegistry();
  setPluginRuntimeLoadContext(registry, resolvePluginRuntimeLoadContext(options));
  return withPluginRuntimeRegistryScope(registry, run);
}

function loadFixture(options: Partial<Parameters<typeof loadOpenClawPlugins>[0]> = {}) {
  return loadOpenClawPlugins({
    cache: false,
    config: fixtureConfig,
    onlyPluginIds: ["fixture"],
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolvePluginRuntimeArtifact", () => {
  it.each(["disabled", "metadata-only"])(
    "does not inspect built runtime files for %s plugins",
    (mode) => {
      const fixture = createBundledPluginFixture();
      const open = vi.spyOn(fs, "openSync");
      const registry = fixture.withEnv(() =>
        loadFixture({
          config: pluginConfig(mode !== "disabled"),
          loadModules: mode !== "metadata-only",
          preferBuiltPluginArtifacts: true,
        }),
      );
      expect(registry.plugins).toMatchObject([{ id: "fixture", enabled: mode !== "disabled" }]);
      const builtRoot = path.dirname(fixture.builtSource);
      expect(
        open.mock.calls.filter(
          ([file]) => typeof file === "string" && file.startsWith(`${builtRoot}${path.sep}`),
        ),
      ).toEqual([]);
    },
  );

  it.each(["source default", "package-local", "root-bundled"])(
    "exposes and fingerprints the selected %s runtime entry",
    (layout) => {
      const preferBuiltPluginArtifacts = layout === "source default" ? undefined : true;
      const fixture = createBundledPluginFixture();
      const entry = !preferBuiltPluginArtifacts
        ? fixture.source
        : layout === "package-local"
          ? path.join(fixture.rootDir, "dist", "index.js")
          : fixture.builtSource;
      const name = preferBuiltPluginArtifacts ? "fixture-built" : "fixture-source";
      write(
        entry,
        `export default {
          id: "fixture", name: ${JSON.stringify(name)},
          register(api) {
            api.registerService({ id: api.runtimeSource ?? "missing runtime source", start() {} });
          }
        };`,
      );
      fixture.withEnv(() => {
        const record = { pluginId: "fixture", origin: "bundled" as const, ...fixture };
        const before = withStagingRegistry(
          { config: fixtureConfig, preferBuiltPluginArtifacts },
          () => fingerprintPluginRuntimeArtifact(record),
        );
        const registry = loadFixture({ preferBuiltPluginArtifacts });
        expect(registry.services.map(({ service }) => service.id)).toEqual([entry]);
        expect(registry.plugins[0]?.source).toBe(fixture.source);
        expectLoaded(registry, { name });
        expect(fixture.resolve(!preferBuiltPluginArtifacts).source).toBe(entry);
        expect(fingerprintPluginRuntimeArtifact(record)).toBe(before);
        fs.appendFileSync(entry, "\n// Runtime artifact replaced.\n");
        expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(before);
      });
    },
  );

  it.each(["missing", "present", "staging-symlink", "canonical-directory-symlink"])(
    "keeps the execution entry and boundary together for a %s canonical entry",
    (layout) => {
      const fixture = createBundledPluginFixture();
      const { packageRoot, builtRoot } = fixture;
      const stagingRoot = path.join(packageRoot, "dist-runtime", "extensions", "fixture");
      const stagingSource = path.join(stagingRoot, "setup-entry.js");
      const builtSource = path.join(builtRoot, "setup-entry.js");
      if (layout === "canonical-directory-symlink") {
        const outputRoot = path.join(packageRoot, "outputs");
        fs.renameSync(builtRoot, outputRoot);
        fs.symlinkSync(outputRoot, builtRoot, "junction");
      }
      fs.mkdirSync(stagingRoot, { recursive: true });
      const canonicalEntryExists = layout !== "missing";
      if (canonicalEntryExists) {
        fs.writeFileSync(builtSource, "module.exports = {};\n");
      }
      if (layout === "staging-symlink" || layout === "canonical-directory-symlink") {
        fs.symlinkSync(builtSource, stagingSource);
      } else {
        fs.writeFileSync(stagingSource, "module.exports = {};\n");
      }
      const selected = { source: stagingSource, rootDir: stagingRoot };
      const expected = canonicalEntryExists
        ? { source: fs.realpathSync(builtSource), rootDir: builtRoot }
        : selected;

      expect(resolveFixture({ ...selected, entryKind: "setup" })).toEqual(expected);
    },
  );

  it.each([
    { extension: ".cjs", neighbor: "built", missing: false },
    { extension: ".js", neighbor: "built", missing: false },
    { extension: ".cjs", neighbor: "built", missing: true },
    { extension: ".js", neighbor: "source", missing: false },
    { extension: ".js", neighbor: "package-local", missing: false },
  ])(
    "selects declared $extension output over a stale $neighbor neighbor (missing: $missing)",
    ({ extension, neighbor, missing }) => {
      const fixture = createBundledPluginFixture(extension);
      const staleExtension = extension === ".js" ? ".cjs" : ".js";
      const stale =
        neighbor === "built"
          ? path.join(path.dirname(fixture.builtSource), `index${staleExtension}`)
          : path.join(fixture.rootDir, neighbor === "source" ? "index.js" : "dist/index.js");
      write(stale, 'throw new Error("stale build output");\n');
      if (missing) {
        fs.rmSync(fixture.builtSource);
      }
      const resolved = fixture.resolve(true, {
        packageManifest:
          neighbor === "package-local" ? { build: { bundledDist: false } } : undefined,
      });
      expect(resolved.source).toBe(missing ? fixture.source : fixture.builtSource);
      expect(resolved.source).not.toBe(fs.realpathSync(stale));
    },
  );

  it("never borrows a checkout root build for an installed package", () => {
    const fixture = createBundledPluginFixture();
    expect(fixture.resolve(true, { origin: "global" }).source).toBe(fixture.source);
  });

  it.each([
    ["runtime", "index"],
    ["setup", "setup-entry"],
    ["provider-discovery", "provider-discovery"],
  ] as const)(
    "keeps source-external %s entries inside their selected root after packaging",
    (entryKind, stem) => {
      const fixture = createBundledPluginFixture();
      const { packageRoot, builtRoot } = fixture;
      const artifactName = `${stem}.js`;
      const source = path.join(fixture.rootDir, `${stem}.ts`);
      if (source !== fixture.source) {
        write(source, emptyPlugin);
      }
      const stagingSource = path.join(packageRoot, "dist-runtime/extensions/fixture", artifactName);
      write(stagingSource, `export * from "../../../dist/extensions/fixture/${artifactName}";\n`);
      fs.rmSync(builtRoot, { recursive: true });
      const packagedSource = path.join(builtRoot, "dist", artifactName);
      write(packagedSource, 'module.exports = { id: "packed" };\n');
      writeJson(path.join(builtRoot, "package.json"), {
        openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
      });

      const resolved = fixture.resolve(true, {
        entryKind,
        source,
        packageManifest: { build: { bundledDist: false } },
      });

      expect(resolved).toEqual({ source: fs.realpathSync(source), rootDir: fixture.rootDir });
    },
  );

  it.each(["setup", "provider-discovery"] as const)(
    "keeps runtime and %s entries distinct within one plugin root",
    (entryKind) => {
      const fixture = createBundledPluginFixture();
      const setupSource = path.join(fixture.rootDir, "setup-entry.ts");
      write(setupSource, emptyPlugin);
      const runtime = fixture.resolve();
      const source = fs.realpathSync(setupSource);
      const setup = fixture.resolve(false, { entryKind, source });
      expect([runtime.source, setup.source]).toEqual([fixture.source, source]);
    },
  );

  it("re-resolves after the registry load cache is cleared", () => {
    const fixture = createBundledPluginFixture();
    const sourceResolution = fixture.resolve();

    clearPluginRegistryLoadCache();

    const builtResolution = fixture.resolve(true);
    expect([sourceResolution.source, builtResolution.source]).toEqual([
      fixture.source,
      fixture.builtSource,
    ]);
  });

  it("resolves replacement artifacts independently while pinned consumers keep their registry", () => {
    const fixture = createBundledPluginFixture();
    const [first, second] = fixture.withEnv(() => [
      loadFixture({ preferBuiltPluginArtifacts: false }),
      loadFixture({ preferBuiltPluginArtifacts: true }),
    ]);

    expect(
      [first, second].map((registry) =>
        [...registry.pluginRuntimeArtifacts.values()].map((entry) => entry.source),
      ),
    ).toEqual([[fixture.source], [fixture.builtSource]]);
    expect(getActivePluginChannelRegistry()).toBe(second);
  });

  it("binds explicit bundled source selection before a built-preferred runtime loads", async () => {
    const { captureSystemAgentOwnerPluginArtifacts } =
      await import("../system-agent/verified-inference.js");
    const fixture = createBundledPluginFixture(".js", ["fixture"]);
    const { packageRoot } = fixture;
    write(fixture.source, 'export default { name: "fixture-source", register() {} };\n');
    write(fixture.builtSource, 'module.exports = { name: "fixture-built", register() {} };\n');
    fixture.withEnv(
      () => {
        const config: OpenClawConfig = {
          agents: {
            defaults: { workspace: path.join(packageRoot, "workspace") },
            entries: { main: {} },
          },
          plugins: {
            ...fixtureConfig.plugins,
            load: { paths: [fixture.rootDir] },
          },
        };
        const capture = () =>
          captureSystemAgentOwnerPluginArtifacts({
            config,
            executionRoute: {
              sourceConfig: config,
              runConfig: config,
              modelLabel: "fixture/model",
              provider: "fixture",
              model: "model",
              agentDir: path.join(packageRoot, "agent"),
              agentId: "main",
              runner: "embedded",
              agentHarnessRuntimeOverride: "openclaw",
            },
          });
        const before = withStagingRegistry({ config, preferBuiltPluginArtifacts: true }, capture);
        expect(before.ownerPluginIds).toEqual(["fixture"]);
        const registry = loadFixture({ config, preferBuiltPluginArtifacts: true });
        expectLoaded(registry, { name: "fixture-source" });
        expect(capture()).toEqual(before);
        fs.appendFileSync(fixture.source, "\n// Runtime artifact replaced.\n");
        expect(capture()).not.toEqual(before);
      },
      { OPENCLAW_STATE_DIR: path.join(packageRoot, "state") },
    );
  });
});
