import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { fingerprintPluginRuntimeArtifact } from "./plugin-runtime-artifact-identity.js";
import {
  clearPluginRuntimeArtifactResolutionMemo,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import { resolvePluginRuntimeExecutionArtifact } from "./plugin-runtime-artifact-selection.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginChannelRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";

const tempDirs: string[] = [];

function createBundledPluginFixture(builtExtension = ".js"): {
  rootDir: string;
  source: string;
  builtSource: string;
} {
  const packageRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-runtime-artifact-")),
  );
  tempDirs.push(packageRoot);
  const rootDir = path.join(packageRoot, "extensions", "fixture");
  const source = path.join(rootDir, "index.ts");
  const builtSource = path.join(
    packageRoot,
    "dist",
    "extensions",
    "fixture",
    `index${builtExtension}`,
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(builtSource), { recursive: true });
  fs.writeFileSync(source, "export default { register() {} };\n");
  fs.writeFileSync(builtSource, 'module.exports = { id: "fixture", register() {} };\n');
  fs.writeFileSync(
    path.join(path.dirname(builtSource), "package.json"),
    JSON.stringify({
      openclaw: { extensions: [`./index${builtExtension}`], build: { runtimeFormat: "cjs" } },
    }),
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  return {
    rootDir: fs.realpathSync(rootDir),
    source: fs.realpathSync(source),
    builtSource: fs.realpathSync(builtSource),
  };
}

function resolveFixture(params: {
  rootDir: string;
  source: string;
  preferBuiltPluginArtifacts: boolean;
}) {
  return resolvePluginRuntimeArtifact({
    pluginId: "fixture",
    entryKind: "runtime",
    rootDir: params.rootDir,
    source: params.source,
    origin: "bundled",
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
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
      const registry = withEnv(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(fixture.rootDir),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        },
        () =>
          loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["fixture"],
                entries: { fixture: { enabled: mode !== "disabled" } },
              },
            },
            onlyPluginIds: ["fixture"],
            loadModules: mode !== "metadata-only",
            preferBuiltPluginArtifacts: true,
          }),
      );
      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0]?.id).toBe("fixture");
      expect(registry.plugins[0]?.enabled).toBe(mode !== "disabled");
      const builtRoot = path.dirname(fixture.builtSource);
      expect(
        open.mock.calls.filter(
          ([file]) => typeof file === "string" && file.startsWith(`${builtRoot}${path.sep}`),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    { layout: "source default", preferBuiltPluginArtifacts: undefined },
    { layout: "source", preferBuiltPluginArtifacts: false },
    { layout: "package-local", preferBuiltPluginArtifacts: true },
    { layout: "root-bundled", preferBuiltPluginArtifacts: true },
  ])(
    "exposes and fingerprints the selected $layout runtime entry",
    ({ layout, preferBuiltPluginArtifacts }) => {
      const fixture = createBundledPluginFixture();
      const entry = !preferBuiltPluginArtifacts
        ? fixture.source
        : layout === "package-local"
          ? path.join(fixture.rootDir, "dist", "index.js")
          : fixture.builtSource;
      const name = preferBuiltPluginArtifacts ? "fixture-built" : "fixture-source";
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(
        entry,
        `export default {
          id: "fixture", name: ${JSON.stringify(name)},
          register(api) {
            api.registerService({ id: api.runtimeSource ?? "missing runtime source", start() {} });
          }
        };`,
      );
      withEnv(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(fixture.rootDir),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        },
        () => {
          const config = {
            plugins: { allow: ["fixture"], entries: { fixture: { enabled: true } } },
          };
          const record = { pluginId: "fixture", origin: "bundled" as const, ...fixture };
          const stagingRegistry = createEmptyPluginRegistry();
          setPluginRuntimeLoadContext(
            stagingRegistry,
            resolvePluginRuntimeLoadContext({ config, preferBuiltPluginArtifacts }),
          );
          const before = withPluginRuntimeRegistryScope(stagingRegistry, () =>
            fingerprintPluginRuntimeArtifact(record),
          );
          const registry = loadOpenClawPlugins({
            cache: false,
            config,
            onlyPluginIds: ["fixture"],
            preferBuiltPluginArtifacts,
          });
          expect(registry.services.map(({ service }) => service.id)).toEqual([entry]);
          expect(registry.plugins[0]?.source).toBe(fixture.source);
          expect(registry.plugins).toContainEqual(
            expect.objectContaining({ id: "fixture", name, status: "loaded" }),
          );
          expect(fingerprintPluginRuntimeArtifact(record)).toBe(before);
          fs.appendFileSync(entry, "\n// Runtime artifact replaced.\n");
          expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(before);
        },
      );
    },
  );

  it.each(["missing", "present", "staging-symlink", "canonical-directory-symlink"])(
    "keeps the execution entry and boundary together for a %s canonical entry",
    (layout) => {
      const fixture = createBundledPluginFixture();
      const packageRoot = path.dirname(path.dirname(fixture.rootDir));
      const stagingRoot = path.join(packageRoot, "dist-runtime", "extensions", "fixture");
      const stagingSource = path.join(stagingRoot, "setup-entry.js");
      const builtRoot = path.dirname(fixture.builtSource);
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

      expect(
        resolvePluginRuntimeExecutionArtifact({
          ...selected,
          source: fs.realpathSync(stagingSource),
        }),
      ).toEqual(expected);
      expect(
        resolvePluginRuntimeArtifact({
          ...selected,
          pluginId: "fixture",
          entryKind: "setup",
          origin: "bundled",
          preferBuiltPluginArtifacts: false,
        }),
      ).toEqual(expected);
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
      fs.mkdirSync(path.dirname(stale), { recursive: true });
      fs.writeFileSync(stale, 'throw new Error("stale build output");\n');
      if (missing) {
        fs.rmSync(fixture.builtSource);
      }
      const resolved = resolvePluginRuntimeArtifact({
        ...fixture,
        pluginId: "fixture",
        entryKind: "runtime",
        origin: "bundled",
        preferBuiltPluginArtifacts: true,
        packageManifest:
          neighbor === "package-local" ? { build: { bundledDist: false } } : undefined,
      });
      expect(resolved.source).toBe(missing ? fixture.source : fixture.builtSource);
      expect(resolved.source).not.toBe(fs.realpathSync(stale));
    },
  );

  it("never borrows a checkout root build for an installed package", () => {
    const fixture = createBundledPluginFixture();
    expect(
      resolvePluginRuntimeArtifact({
        ...fixture,
        pluginId: "fixture",
        entryKind: "runtime",
        origin: "global",
        preferBuiltPluginArtifacts: true,
      }).source,
    ).toBe(fixture.source);
  });

  it.each([
    { firstPreference: false, firstArtifact: "source" },
    { firstPreference: true, firstArtifact: "built" },
  ])(
    "pins the first $firstArtifact path so one plugin instance registers once",
    ({ firstPreference }) => {
      const fixture = createBundledPluginFixture();
      const first = resolveFixture({
        ...fixture,
        preferBuiltPluginArtifacts: firstPreference,
      });
      const second = resolveFixture({
        ...fixture,
        preferBuiltPluginArtifacts: !firstPreference,
      });

      expect(first.source).toBe(firstPreference ? fixture.builtSource : fixture.source);
      expect(second).toEqual(first);
      expect(
        resolveFixture({
          ...fixture,
          source: firstPreference ? fixture.source : fixture.builtSource,
          preferBuiltPluginArtifacts: !firstPreference,
        }),
      ).toEqual(first);
    },
  );

  it.each([
    { entryKind: "runtime" as const, sourceName: "index.ts", artifactName: "index.js" },
    {
      entryKind: "setup" as const,
      sourceName: "setup-entry.ts",
      artifactName: "setup-entry.js",
    },
    {
      entryKind: "provider-discovery" as const,
      sourceName: "provider-discovery.ts",
      artifactName: "provider-discovery.js",
    },
  ])(
    "keeps source-external $entryKind entries inside their selected root after packaging",
    ({ entryKind, sourceName, artifactName }) => {
      const fixture = createBundledPluginFixture();
      const packageRoot = path.dirname(path.dirname(fixture.rootDir));
      const source = path.join(fixture.rootDir, sourceName);
      if (source !== fixture.source) {
        fs.writeFileSync(source, "export default { register() {} };\n");
      }
      const stagingSource = path.join(
        packageRoot,
        "dist-runtime",
        "extensions",
        "fixture",
        artifactName,
      );
      fs.mkdirSync(path.dirname(stagingSource), { recursive: true });
      fs.writeFileSync(
        stagingSource,
        `export * from "../../../dist/extensions/fixture/${artifactName}";\n`,
      );
      fs.rmSync(path.dirname(fixture.builtSource), { recursive: true });
      const packagedSource = path.join(
        packageRoot,
        "dist",
        "extensions",
        "fixture",
        "dist",
        artifactName,
      );
      fs.mkdirSync(path.dirname(packagedSource), { recursive: true });
      fs.writeFileSync(packagedSource, 'module.exports = { id: "packed" };\n');
      fs.writeFileSync(
        path.join(packageRoot, "dist", "extensions", "fixture", "package.json"),
        JSON.stringify({
          openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
        }),
      );

      const resolved = resolvePluginRuntimeArtifact({
        pluginId: "fixture",
        entryKind,
        rootDir: fixture.rootDir,
        source,
        origin: "bundled",
        preferBuiltPluginArtifacts: true,
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
      fs.writeFileSync(setupSource, "export default { register() {} };\n");
      const runtime = resolveFixture({
        ...fixture,
        preferBuiltPluginArtifacts: false,
      });
      const setup = resolvePluginRuntimeArtifact({
        pluginId: "fixture",
        entryKind,
        rootDir: fixture.rootDir,
        source: fs.realpathSync(setupSource),
        origin: "bundled",
        preferBuiltPluginArtifacts: false,
      });

      expect(runtime.source).toBe(fixture.source);
      expect(setup.source).toBe(fs.realpathSync(setupSource));
    },
  );

  it.each([
    ["active registry memo", clearPluginRuntimeArtifactResolutionMemo],
    ["registry load cache", clearPluginRegistryLoadCache],
  ] as const)("re-resolves after the %s is cleared", (_name, clear) => {
    const fixture = createBundledPluginFixture();
    const sourceResolution = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: false,
    });

    clear();

    const builtResolution = resolveFixture({
      ...fixture,
      preferBuiltPluginArtifacts: true,
    });
    expect(sourceResolution.source).toBe(fixture.source);
    expect(builtResolution.source).toBe(fixture.builtSource);
  });

  it("resolves replacement artifacts independently while pinned consumers keep their registry", () => {
    const fixture = createBundledPluginFixture();
    const config = {
      plugins: {
        allow: ["fixture"],
        entries: { fixture: { enabled: true } },
      },
    };

    const [first, second] = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(fixture.rootDir),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () => {
        const sourceRegistry = loadOpenClawPlugins({
          cache: false,
          config,
          onlyPluginIds: ["fixture"],
          preferBuiltPluginArtifacts: false,
        });
        const builtPreferredRegistry = loadOpenClawPlugins({
          cache: false,
          config,
          onlyPluginIds: ["fixture"],
          preferBuiltPluginArtifacts: true,
        });
        return [sourceRegistry, builtPreferredRegistry];
      },
    );

    expect([...first.pluginRuntimeArtifacts.values()].map((entry) => entry.source)).toEqual([
      fixture.source,
    ]);
    expect([...second.pluginRuntimeArtifacts.values()].map((entry) => entry.source)).toEqual([
      fixture.builtSource,
    ]);
    expect(getActivePluginChannelRegistry()).toBe(second);
  });

  it("binds explicit bundled source selection before a built-preferred runtime loads", async () => {
    const { captureSystemAgentOwnerPluginArtifacts } =
      await import("../system-agent/verified-inference.js");
    const fixture = createBundledPluginFixture();
    const packageRoot = path.dirname(path.dirname(fixture.rootDir));
    fs.writeFileSync(fixture.source, 'export default { name: "fixture-source", register() {} };\n');
    fs.writeFileSync(
      fixture.builtSource,
      'module.exports = { name: "fixture-built", register() {} };\n',
    );
    fs.writeFileSync(
      path.join(fixture.rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "fixture",
        providers: ["fixture"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(fixture.rootDir),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_STATE_DIR: path.join(packageRoot, "state"),
      },
      () => {
        const workspaceDir = path.join(packageRoot, "workspace");
        const config: OpenClawConfig = {
          agents: {
            defaults: { workspace: workspaceDir },
            entries: { main: {} },
          },
          plugins: {
            allow: ["fixture"],
            entries: { fixture: { enabled: true } },
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
        const stagingRegistry = createEmptyPluginRegistry();
        setPluginRuntimeLoadContext(
          stagingRegistry,
          resolvePluginRuntimeLoadContext({ config, preferBuiltPluginArtifacts: true }),
        );
        const before = withPluginRuntimeRegistryScope(stagingRegistry, capture);
        expect(before.ownerPluginIds).toEqual(["fixture"]);
        const registry = loadOpenClawPlugins({
          cache: false,
          config,
          onlyPluginIds: ["fixture"],
          preferBuiltPluginArtifacts: true,
        });
        expect(registry.plugins).toContainEqual(
          expect.objectContaining({ id: "fixture", name: "fixture-source", status: "loaded" }),
        );
        expect(capture()).toEqual(before);
        fs.appendFileSync(fixture.source, "\n// Runtime artifact replaced.\n");
        expect(capture()).not.toEqual(before);
      },
    );
  });

  it("leaves dist-only installs unchanged because both preferences resolve the built entry", () => {
    const packageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-runtime-dist-only-")),
    );
    tempDirs.push(packageRoot);
    const rootDir = path.join(packageRoot, "dist", "extensions", "fixture");
    const source = path.join(rootDir, "index.js");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(source, "export default { register() {} };\n");
    const canonicalRootDir = fs.realpathSync(rootDir);
    const canonicalSource = fs.realpathSync(source);

    const sourcePreferred = resolveFixture({
      rootDir: canonicalRootDir,
      source: canonicalSource,
      preferBuiltPluginArtifacts: false,
    });
    clearPluginRuntimeArtifactResolutionMemo();
    const builtPreferred = resolveFixture({
      rootDir: canonicalRootDir,
      source: canonicalSource,
      preferBuiltPluginArtifacts: true,
    });

    expect(sourcePreferred).toEqual({ source: canonicalSource, rootDir: canonicalRootDir });
    expect(builtPreferred).toEqual(sourcePreferred);
  });
});
