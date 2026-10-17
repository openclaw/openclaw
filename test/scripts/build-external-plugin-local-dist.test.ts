import { execFileSync, spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildAllSteps, runBuildAllSteps } from "../../scripts/build-all.mts";
import {
  buildExternalPluginLocalDist,
  listExternalPluginLocalDistPackageDirs,
} from "../../scripts/build-external-plugin-local-dist.mts";
import {
  parseBundledPluginAssetArgs,
  runBundledPluginAssetHooks,
} from "../../scripts/bundled-plugin-assets.mts";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import {
  collectRootPackageExcludedExtensionDirs,
  collectSourceCheckoutPluginBuildEntries,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { BUILD_STAMP_FILE } from "../../scripts/lib/local-build-metadata-paths.mts";
import { resolveBuildRequirement } from "../../scripts/run-node.mts";
import { hasChannelPackageState } from "../../src/channels/plugins/package-state-probes.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import {
  createPluginCache,
  resetPluginCache,
  withPluginCache,
} from "../../src/plugins/plugin-cache.js";
import { resolvePluginRuntimeArtifact } from "../../src/plugins/plugin-runtime-artifact-resolution.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetPluginCache);

const channelStateFixtures = {
  configuredState: {
    specifier: "./configured-state",
    exportName: "hasConfiguredChannelState",
    env: { allOf: ["DEMO_TOKEN"] },
  },
  persistedAuthState: {
    specifier: "./auth-presence.ts",
    exportName: "hasPersistedChannelAuth",
  },
};

const readText = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
const readJson = (...parts: string[]) => JSON.parse(readText(...parts));
const buildExternal = (repoRoot: string) =>
  buildExternalPluginLocalDist({ repoRoot, env: {}, logLevel: "silent" });
const copyMetadata = (repoRoot: string, env = {}) => copyBundledPluginMetadata({ repoRoot, env });

function runModule(code: string, options: SpawnSyncOptions = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    ...options,
    encoding: "utf8",
  });
}

function writeFiles(root: string, files: Record<string, string | object>) {
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
}

function makeRepo(prefix: string, metadata: object = {}) {
  const root = fs.realpathSync(tempDirs.make(`openclaw-${prefix}-`));
  writeFiles(root, {
    "package.json": { name: "openclaw", version: "1.0.0", type: "module", ...metadata },
  });
  return root;
}

function makePlugin(
  repoRoot: string,
  id: string,
  openclaw: object = {},
  files: Record<string, string | object> = {},
  metadata: object = {},
) {
  const root = path.join(repoRoot, "extensions", id);
  writeFiles(root, {
    "package.json": {
      name: `@openclaw/${id}`,
      version: "1.0.0",
      type: "module",
      openclaw: {
        extensions: ["./index.ts"],
        build: { bundledDist: false },
        release: { publishToNpm: true },
        ...openclaw,
      },
      ...metadata,
    },
    "openclaw.plugin.json": { id },
    "index.ts": "export {};\n",
    ...files,
  });
  return root;
}

function writeChannelStateFixtures(pluginRoot: string) {
  for (const { specifier, exportName } of Object.values(channelStateFixtures)) {
    fs.writeFileSync(
      path.join(pluginRoot, `${specifier.replace(/\.ts$/u, "")}.ts`),
      `export function ${exportName}({ cfg }) { return cfg.ready === true; }\n`,
    );
  }
}

function builtChannelState(extension: string) {
  return Object.fromEntries(
    Object.entries(channelStateFixtures).map(([key, declaration]) => [
      key,
      { ...declaration, specifier: declaration.specifier.replace(/\.ts$/u, "") + extension },
    ]),
  );
}

function buildReadiness(repoRoot: string, env = {}) {
  const distRoot = path.join(repoRoot, "dist");
  const distEntry = path.join(distRoot, "entry.js");
  const buildStampPath = path.join(distRoot, BUILD_STAMP_FILE);
  writeFiles(distRoot, { "entry.js": "export {};\n", [BUILD_STAMP_FILE]: "{}\n" });
  return {
    cwd: repoRoot,
    env,
    fs,
    distRoot,
    distEntry,
    buildStampPath,
    configFiles: [],
    sourceRoots: [],
    spawnSync: () => ({ status: 1 }),
  };
}

describe("external plugin local dist build", () => {
  it("restores complete plugin outputs and rebuilds only changed package inputs", async () => {
    const repoRoot = makeRepo("external-plugin-cache");
    for (const id of ["first", "second"]) {
      makePlugin(
        repoRoot,
        id,
        {
          assetScripts: {
            build: "node build-assets.mjs",
            buildOutputs: ["dist/control-ui/version/index.js", "assets/generated.txt"],
          },
        },
        {
          "index.ts": "export const value = 1;\n",
          "build-assets.mjs": `import fs from "node:fs";
if (fs.existsSync("../../forbid-build")) throw new Error("unchanged plugin was rebuilt");
fs.appendFileSync("../../builds.txt", ${JSON.stringify(`${id}\n`)});
fs.mkdirSync("dist/control-ui/version", { recursive: true });
fs.mkdirSync("assets", { recursive: true });
fs.writeFileSync("dist/control-ui/version/index.js", "browser asset");
fs.writeFileSync("assets/generated.txt", "generated asset");
`,
        },
      );
    }
    const build = () => buildExternal(repoRoot);
    const builds = () => readText(repoRoot, "builds.txt");
    await build();
    expect(builds()).toBe("first\nsecond\n");
    fs.rmSync(path.join(repoRoot, "dist"), { recursive: true });
    for (const id of ["first", "second"]) {
      fs.rmSync(path.join(repoRoot, "extensions", id, "dist"), { recursive: true });
      fs.rmSync(path.join(repoRoot, "extensions", id, "assets/generated.txt"));
    }
    fs.writeFileSync(path.join(repoRoot, "forbid-build"), "");
    await build();
    expect(builds()).toBe("first\nsecond\n");
    for (const id of ["first", "second"]) {
      expect(readText(repoRoot, "dist/extensions", id, "index.js")).toContain("value");
      expect(readText(repoRoot, "extensions", id, "dist/control-ui/version/index.js")).toBe(
        "browser asset",
      );
      expect(readText(repoRoot, "extensions", id, "assets/generated.txt")).toBe("generated asset");
    }
    fs.rmSync(path.join(repoRoot, "forbid-build"));
    fs.writeFileSync(path.join(repoRoot, "extensions/first/index.ts"), "export const value = 2;\n");
    await build();
    expect(builds()).toBe("first\nsecond\nfirst\n");
    expect(readText(repoRoot, "dist/extensions/first/index.js")).toContain("value = 2");
  });

  it("uses generated browser metadata as input without rewriting source or restoring over its output", async () => {
    const repoRoot = makeRepo("plugin-early-assets");
    const pluginRoot = makePlugin(repoRoot, "demo", {
      controlUi: "./browser.ts",
      assetScripts: {
        build: "node build-assets.mjs",
        buildOutputs: ["dist/openclaw.plugin.json"],
      },
    });
    const authored = JSON.stringify({
      id: "demo",
      configSchema: { type: "object", properties: { preserved: { type: "string" } } },
      controlUi: { entry: "dist/control-ui/authored/index.js" },
    });
    writeFiles(pluginRoot, {
      "openclaw.plugin.json": authored,
      "index.ts": "export const backend = true;\n",
      "build-assets.mjs": `import fs from "node:fs";
const identity = fs.readFileSync("../../browser-identity.txt", "utf8");
const entry = "dist/control-ui/" + identity + "/index.js";
fs.mkdirSync("dist/control-ui/" + identity, { recursive: true });
fs.writeFileSync("dist/openclaw.plugin.json", JSON.stringify({ id: "previous-name", controlUi: { entry } }));
fs.writeFileSync(entry, identity);
`,
    });
    const build = async (identity: string) => {
      // An input outside the backend graph models a changed host browser SDK.
      fs.writeFileSync(path.join(repoRoot, "browser-identity.txt"), identity);
      await runBundledPluginAssetHooks({ rootDir: repoRoot, phase: "build", deferIsolated: true });
      fs.rmSync(path.join(repoRoot, "dist"), { recursive: true, force: true });
      await buildExternal(repoRoot);
      copyMetadata(repoRoot);
    };
    expect(loadPluginManifest(pluginRoot)).toMatchObject({
      ok: true,
      manifest: JSON.parse(authored),
    });
    await build("first");
    await build("second");
    expect(readText(pluginRoot, "openclaw.plugin.json")).toBe(authored);
    const expected = {
      ...JSON.parse(authored),
      controlUi: { entry: "dist/control-ui/second/index.js" },
    };
    expect(
      withPluginCache(createPluginCache(), () => loadPluginManifest(pluginRoot)),
    ).toMatchObject({ ok: true, manifest: expected });
    expect(readJson(repoRoot, "dist/extensions/demo/openclaw.plugin.json")).toMatchObject(expected);
    const ownedAsset = path.join(pluginRoot, "dist/control-ui/second/owner.js");
    fs.writeFileSync(ownedAsset, "early owner output");
    await build("second");
    expect(readText(ownedAsset)).toBe("early owner output");
  });

  it.each([
    ["dist/extensions", "demo/node_modules/sentinel.txt", "junction"],
    ["dist/extensions/demo", "node_modules/sentinel.txt", "junction"],
    ["dist/extensions/demo/skills", "example/SKILL.md", "junction"],
    ["dist/extensions/demo/assets", "icon.png", "junction"],
    ["dist/extensions/demo/package.json", "package.json", "file"],
    ["dist/extensions/demo/openclaw.plugin.json", "openclaw.plugin.json", "file"],
  ] as const)(
    "preserves outside files behind a linked metadata output %s",
    (output, sentinel, type) => {
      const repoRoot = makeRepo("plugin-metadata-boundary");
      const outside = tempDirs.make("openclaw-plugin-metadata-outside-");
      makePlugin(
        repoRoot,
        "demo",
        { build: undefined, release: undefined },
        {
          "openclaw.plugin.json": { id: "demo", skills: ["./skills/example"] },
          "skills/example/SKILL.md": "new skill\n",
        },
        { type: undefined },
      );
      const sentinelPath = path.join(outside, sentinel);
      fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
      fs.writeFileSync(sentinelPath, "outside data\n");
      const linkPath = path.join(repoRoot, output);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(type === "file" ? sentinelPath : outside, linkPath, type);

      expect(() => copyMetadata(repoRoot)).toThrow("symbolic link");
      expect(readText(sentinelPath)).toBe("outside data\n");
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    },
  );

  it("keeps excluded plugin graphs isolated and their runtime metadata loadable", async () => {
    const browserEntry = `dist/control-ui/${"a".repeat(64)}/index.js`;
    const browserSource = "export const browserUi = true;\n";
    const plugins = [
      { id: "external-cjs", runtimeFormat: "cjs", publishToNpm: true, bundledDist: true },
      { id: "external-esm", runtimeFormat: "esm", publishToNpm: true, bundledDist: true },
      { id: "external-only", runtimeFormat: "cjs", publishToNpm: true, bundledDist: false },
      { id: "private-plugin", runtimeFormat: "esm", publishToNpm: false, bundledDist: true },
    ];
    const repoRoot = makeRepo("isolated-plugin-graphs", {
      files: ["dist/**", ...plugins.map(({ id }) => `!dist/extensions/${id}/**`)],
    });
    for (const { id, runtimeFormat, publishToNpm, bundledDist } of plugins) {
      const browserUi = id === "external-only";
      const cjsAssets = id === "external-cjs";
      const pluginRoot = makePlugin(
        repoRoot,
        id,
        {
          setupEntry: "./setup-entry.ts",
          channel: { id, label: id, ...channelStateFixtures },
          build: {
            runtimeFormat,
            bundledDist,
            staticAssets: cjsAssets
              ? [{ source: "./assets/generated.txt", output: "assets/generated.txt" }]
              : undefined,
          },
          release: { publishToNpm },
          controlUi: browserUi ? "./browser/index.ts" : undefined,
          assetScripts: browserUi
            ? { build: "node build-browser.mjs", buildOutputs: ["dist/openclaw.plugin.json"] }
            : cjsAssets
              ? { build: "node scripts/build-assets.cjs", buildOutputs: ["assets/generated.txt"] }
              : undefined,
        },
        {
          "openclaw.plugin.json": {
            id,
            controlUi: browserUi
              ? { entry: `dist/control-ui/${"b".repeat(64)}/index.js` }
              : undefined,
          },
        },
      );
      if (id === "external-cjs") {
        writeFiles(pluginRoot, {
          "scripts/build-assets.cjs": `const fs = require("node:fs");
fs.appendFileSync("asset-builds.txt", "built\\n");
fs.mkdirSync("assets", { recursive: true });
fs.writeFileSync("assets/generated.txt", "generated asset");
`,
        });
      }
      if (browserUi) {
        fs.writeFileSync(
          path.join(pluginRoot, "build-browser.mjs"),
          `import fs from "node:fs";
           const before = fs.readFileSync("openclaw.plugin.json", "utf8");
           const manifest = JSON.parse(before);
           manifest.controlUi = { entry: ${JSON.stringify(browserEntry)} };
           const after = JSON.stringify(manifest, null, 2) + "\\n";
           fs.mkdirSync(${JSON.stringify(path.posix.dirname(browserEntry))}, { recursive: true });
           fs.writeFileSync("dist/openclaw.plugin.json", after);
           fs.writeFileSync(${JSON.stringify(browserEntry)}, ${JSON.stringify(browserSource)});`,
        );
      }
      writeChannelStateFixtures(pluginRoot);
      writeFiles(pluginRoot, {
        "runtime-api.ts": `export const identity = ${JSON.stringify(id)};`,
        "index.ts": 'export { identity } from "./runtime-api.js";',
        "setup-entry.ts": 'export { identity } from "./runtime-api.js";',
      });
    }
    const steps = resolveBuildAllSteps("qaRuntime", {}).filter((step) =>
      ["plugins:assets:build", "external-plugins:local-dist"].includes(step.label),
    );
    const build = (selectedSteps: typeof steps) =>
      runBuildAllSteps("qaRuntime", {
        cwd: repoRoot,
        env: { ...process.env, OPENCLAW_BUILD_ALL_NO_PNPM: "1", GIT_COMMIT: "a".repeat(40) },
        steps: selectedSteps,
        cacheEnabled: false,
        runStep: async (invocation) => {
          if (invocation.args[2] === "scripts/bundled-plugin-assets.mts") {
            await runBundledPluginAssetHooks({
              ...parseBundledPluginAssetArgs(invocation.args.slice(3)),
              rootDir: repoRoot,
            });
            expect(
              readJson(repoRoot, "extensions/external-only/dist/openclaw.plugin.json").controlUi
                .entry,
            ).toBe(browserEntry);
          } else {
            expect(invocation.args[2]).toBe("scripts/build-external-plugin-local-dist.mts");
            await expect(buildExternal(repoRoot)).resolves.toMatchObject({
              pluginDirs: plugins.map(({ id }) => id).toSorted(),
            });
          }
          return { status: 0 };
        },
      });
    expect((await build(steps)).exitCode).toBe(0);
    expect(readText(repoRoot, "extensions/external-cjs/asset-builds.txt")).toBe("built\n");
    expect(readText(repoRoot, "dist/extensions/external-cjs/assets/generated.txt")).toBe(
      "generated asset",
    );
    expect((await build(steps.slice(0, 1))).exitCode).toBe(0);
    expect(readText(repoRoot, "extensions/external-cjs/asset-builds.txt")).toBe("built\nbuilt\n");
    copyMetadata(repoRoot);
    expect(fs.readdirSync(path.join(repoRoot, "dist"))).toEqual(["extensions"]);
    for (const { id, runtimeFormat, bundledDist } of plugins) {
      const pluginRoot = path.join(repoRoot, "dist/extensions", id);
      const metadata = readJson(pluginRoot, "package.json");
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      const { extensions, setupEntry, channel: builtChannel } = metadata.openclaw;
      expect({ extensions, setupEntry, channel: builtChannel }).toEqual({
        extensions: [`./index${extension}`],
        setupEntry: `./setup-entry${extension}`,
        channel: { id, label: id, ...builtChannelState(extension) },
      });
      const sourceRoot = path.join(repoRoot, "extensions", id);
      if (id === "external-only") {
        expect(readText(sourceRoot, browserEntry)).toBe(browserSource);
        expect(fs.readdirSync(path.join(sourceRoot, "dist"))).toEqual([
          "control-ui",
          "openclaw.plugin.json",
        ]);
        expect(fs.existsSync(path.join(pluginRoot, "control-ui"))).toBe(false);
      } else {
        expect(fs.existsSync(path.join(sourceRoot, "dist"))).toBe(false);
      }
      fs.writeFileSync(
        path.join(pluginRoot, runtimeFormat === "cjs" ? "index.js" : "index.cjs"),
        'throw new Error("stale format must not execute");\n',
      );
      const selected = resolvePluginRuntimeArtifact({
        pluginId: id,
        entryKind: "runtime",
        source: path.join(repoRoot, "extensions", id, "index.ts"),
        rootDir: path.join(repoRoot, "extensions", id),
        origin: "bundled",
        preferBuiltPluginArtifacts: true,
        packageManifest: { build: { bundledDist } },
        registry: createEmptyPluginRegistry(),
      });
      expect(selected.source).toBe(path.join(pluginRoot, `index${extension}`));
      const probe = runModule(
        `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import { createRequire } from "node:module";
        import { pathToFileURL } from "node:url";
        const root = pathToFileURL(process.cwd() + "/");
        const require = createRequire(new URL("package.json", root));
        const pkg = JSON.parse(readFileSync(new URL("package.json", root)));
        for (const entry of [...pkg.openclaw.extensions, pkg.openclaw.setupEntry]) {
          assert.equal((await import(new URL(entry, root))).identity, ${JSON.stringify(id)});
        }
        for (const key of ["configuredState", "persistedAuthState"]) {
          const state = pkg.openclaw.channel[key];
          const checker = require(require.resolve(state.specifier))[state.exportName];
          assert.equal(checker({ cfg: {} }), false);
          assert.equal(checker({ cfg: { ready: true } }), true);
        }
      `,
        { cwd: pluginRoot },
      );
      expect(probe.status, probe.stdout + probe.stderr).toBe(0);
      const sourcePackagePath = path.join(repoRoot, "extensions", id, "package.json");
      const sourceText = readText(sourcePackagePath);
      const sourcePackage = JSON.parse(sourceText);
      expect(sourcePackage.openclaw.channel).toEqual({ id, label: id, ...channelStateFixtures });
      const setState = (metadataKey: string, declaration: object) => {
        sourcePackage.openclaw.channel = {
          id,
          label: id,
          ...channelStateFixtures,
          [metadataKey]: declaration,
        };
        fs.writeFileSync(sourcePackagePath, JSON.stringify(sourcePackage));
      };
      // Reuse the built graphs: partial pairs must retain env semantics, not require a sidecar.
      for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
        for (const partial of [
          {},
          { specifier: "./absent-probe" },
          { specifier: "./absent-probe", exportName: " \t" },
          { exportName: "hasState" },
          { specifier: " \t", exportName: "hasState" },
        ]) {
          for (const env of [undefined, { anyOf: ["SYNTHETIC_PLUGIN_TOKEN"] }]) {
            const declaration = { ...partial, ...(env ? { env } : {}) };
            setState(metadataKey, declaration);
            copyMetadata(repoRoot);
            const channel = readJson(pluginRoot, "package.json").openclaw.channel;
            expect(channel).toEqual({ ...metadata.openclaw.channel, [metadataKey]: declaration });
            const stateProbe = {
              entry: { channel, pluginId: id, rootDir: pluginRoot, origin: "bundled" as const },
              metadataKey,
              cfg: {},
            };
            const check = (probeEnv: NodeJS.ProcessEnv) =>
              hasChannelPackageState({ ...stateProbe, env: probeEnv });
            expect([check({}), check({ SYNTHETIC_PLUGIN_TOKEN: "synthetic-test-value" })]).toEqual([
              false,
              Boolean(env),
            ]);
          }
        }
        setState(metadataKey, {
          env: { anyOf: ["SYNTHETIC_PLUGIN_TOKEN"] },
          specifier: "./missing-state",
          exportName: "hasState",
        });
        expect(() => copyMetadata(repoRoot)).toThrow(
          `channel ${metadataKey} specifier './missing-state' has no runtime output for ${id}`,
        );
      }
      fs.writeFileSync(sourcePackagePath, sourceText);
      copyMetadata(repoRoot);
    }

    const readiness = buildReadiness(repoRoot);
    expect(resolveBuildRequirement(readiness)).toEqual({ shouldBuild: false, reason: "clean" });
    // Neither a bundled CJS entry nor an external-only entry may be certified
    // by a stale .js file after its selected .cjs output disappears.
    for (const id of ["external-cjs", "external-only"]) {
      const output = path.join(readiness.distRoot, "extensions", id, "runtime-api.cjs");
      const contents = fs.readFileSync(output);
      fs.unlinkSync(output);
      fs.writeFileSync(output.replace(/\.cjs$/u, ".js"), "export {};\n");
      expect(resolveBuildRequirement(readiness)).toEqual({
        shouldBuild: true,
        reason: "missing_bundled_plugin_dist_entry",
      });
      fs.writeFileSync(output, contents);
    }
  });

  it.for([
    ["esm", false],
    ["cjs", true],
  ] as const)(
    "retains %s source dependencies across metadata profiles and the shared host SDK (relocate=%s)",
    async ([runtimeFormat, relocate], context) => {
      // Windows junctions remain absolute; checkout relocation uses POSIX symlinks.
      if (relocate && process.platform === "win32") {
        context.skip();
      }
      const repoRoot = makeRepo("external-plugin-owners", {
        exports: { "./plugin-sdk/probe": "./dist/plugin-sdk/probe.js" },
      });
      const dependency = "@fixture/private-dep";
      const plugins = [
        ["first", "1.0.0"],
        ["second", "2.0.0"],
      ] as const;
      writeFiles(repoRoot, { "dist/plugin-sdk/probe.js": "export const shared = {};\n" });
      const sourceHostLinks = new Map<string, string>();
      for (const [pluginId, version] of plugins) {
        const packageDir = path.join(repoRoot, "extensions", pluginId);
        const modulesDir = path.join(packageDir, "node_modules");
        const dependencyLink = path.join(modulesDir, dependency);
        const dependencyDir = path.join(repoRoot, "installed", version, "node_modules", dependency);
        fs.mkdirSync(dependencyDir, { recursive: true });
        fs.mkdirSync(path.dirname(dependencyLink), { recursive: true });
        writeFiles(modulesDir, {
          ".bin/probe.cjs": `console.log(require("../${dependency}").version);\n`,
        });
        fs.symlinkSync(
          path.relative(path.dirname(dependencyLink), dependencyDir),
          dependencyLink,
          "dir",
        );
        makePlugin(
          repoRoot,
          pluginId,
          { build: { bundledDist: false, runtimeFormat } },
          {
            "index.ts": `export { version } from "${dependency}";\nexport { shared } from "openclaw/plugin-sdk/probe";\n`,
            "openclaw.plugin.json": { id: pluginId, skills: [`./node_modules/${dependency}`] },
          },
          {
            dependencies: { [dependency]: version },
            peerDependencies: { openclaw: "1.0.0" },
          },
        );
        writeFiles(dependencyDir, {
          "package.json": { name: dependency, version, main: "index.cjs" },
          "index.cjs": `exports.version = ${JSON.stringify(version)};\n`,
          "SKILL.md": `# Private dependency ${version}\n`,
        });
        fs.symlinkSync(
          path.relative(modulesDir, repoRoot),
          path.join(packageDir, "node_modules", "openclaw"),
          "dir",
        );
        sourceHostLinks.set(pluginId, fs.readlinkSync(path.join(modulesDir, "openclaw")));
      }
      await buildExternal(repoRoot);
      // Start with the previous build's directory link, then exercise both profile transitions.
      for (const [pluginId] of plugins) {
        fs.symlinkSync(
          path.join(repoRoot, "extensions", pluginId, "node_modules"),
          path.join(repoRoot, "dist", "extensions", pluginId, "node_modules"),
          "junction",
        );
      }
      // Old output links belong to the previous profile, even when the new plan is unified.
      for (const [profile, env, isolated] of [
        [
          "legacy Docker unified",
          { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "first,second" },
          false,
        ],
        ["isolated", {}, true],
        ["Docker unified", { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "first,second" }, false],
        ["isolated again", {}, true],
        ["isolated repeated", {}, true],
      ] as const) {
        copyMetadata(repoRoot, env);
        for (const [pluginId, version] of plugins) {
          const sourceModules = path.join(repoRoot, "extensions", pluginId, "node_modules");
          const outputRoot = path.join(repoRoot, "dist", "extensions", pluginId);
          const manifest = readJson(outputRoot, "openclaw.plugin.json");
          expect(
            {
              sourceSkill: readText(sourceModules, dependency, "SKILL.md"),
              isolated: fs.existsSync(path.join(outputRoot, "node_modules", "openclaw")),
              sourceHost: fs.readlinkSync(path.join(sourceModules, "openclaw")),
              skills: manifest.skills,
              bundledSkill: readText(outputRoot, manifest.skills[0], "SKILL.md"),
            },
            profile,
          ).toEqual({
            sourceSkill: `# Private dependency ${version}\n`,
            isolated,
            sourceHost: sourceHostLinks.get(pluginId),
            skills: [`./bundled-skills/${dependency}`],
            bundledSkill: `# Private dependency ${version}\n`,
          });
        }
      }
      let runtimeRoot = repoRoot;
      if (relocate) {
        runtimeRoot = fs.realpathSync(tempDirs.make("openclaw-external-plugin-relocated-"));
        await fs.promises.cp(repoRoot, runtimeRoot, { recursive: true, verbatimSymlinks: true });
        fs.rmSync(repoRoot, { recursive: true });
      }
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      const entryUrl = (pluginId: string) =>
        pathToFileURL(path.join(runtimeRoot, "dist", "extensions", pluginId, `index${extension}`))
          .href;
      const stagedDir = path.join(runtimeRoot, "staged", "first");
      // Moving only a plugin needs POSIX links rebased to their source owners;
      // moving the whole checkout above preserves them. Keep Windows junctions
      // verbatim and use async cp: cpSync can recurse through the host back-link.
      await fs.promises.cp(path.join(runtimeRoot, "dist", "extensions", "first"), stagedDir, {
        recursive: true,
        verbatimSymlinks: process.platform === "win32",
      });
      const output = runModule(`
      import { createRequire } from "node:module";
      import { fileURLToPath } from "node:url";
      const load = ${runtimeFormat === "cjs" ? "(url) => createRequire(import.meta.url)(fileURLToPath(url))" : "(url) => import(url)"};
      const first = await load(${JSON.stringify(entryUrl("first"))});
      const second = await load(${JSON.stringify(entryUrl("second"))});
      const staged = await load(${JSON.stringify(pathToFileURL(path.join(stagedDir, `index${extension}`)).href)});
      const host = await import(${JSON.stringify(pathToFileURL(path.join(runtimeRoot, "dist/plugin-sdk/probe.js")).href)});
      console.log(JSON.stringify({ versions: [first.version, second.version, staged.version], shared: first.shared === host.shared && first.shared === second.shared && first.shared === staged.shared }));
    `);
      expect(output.status, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({
        versions: ["1.0.0", "2.0.0", "1.0.0"],
        shared: true,
      });
      for (const [pluginId, version] of plugins) {
        const modules = path.join(runtimeRoot, "dist", "extensions", pluginId, "node_modules");
        expect(fs.lstatSync(modules).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(modules, "@fixture")).isSymbolicLink()).toBe(false);
        for (const [name, owner] of [
          ["openclaw", path.join(runtimeRoot, "dist", "extensions", "node_modules", "openclaw")],
          [dependency, path.join(runtimeRoot, "installed", version, "node_modules", dependency)],
          [".bin", path.join(runtimeRoot, "extensions", pluginId, "node_modules", ".bin")],
        ] as const) {
          const link = path.join(modules, name);
          if (process.platform !== "win32") {
            expect(path.isAbsolute(fs.readlinkSync(link))).toBe(false);
          }
          expect(fs.realpathSync(link)).toBe(owner);
        }
      }
      expect(
        execFileSync(process.execPath, [path.join(stagedDir, "node_modules/.bin/probe.cjs")], {
          encoding: "utf8",
        }).trim(),
      ).toBe("1.0.0");
    },
  );

  it("selects every externalized first-party plugin behind a package exclusion", () => {
    const packageDirs = listExternalPluginLocalDistPackageDirs();
    const excludedPluginIds = collectRootPackageExcludedExtensionDirs();
    expect(packageDirs).toEqual(
      expect.arrayContaining(
        "diffs diffs-language-pack discord feishu matrix slack sms mxc whatsapp codex diagnostics-otel msteams visitor-access"
          .split(" ")
          .map((id) => `extensions/${id}`),
      ),
    );
    expect(
      packageDirs.every((packageDir) => excludedPluginIds.has(packageDir.split("/").at(-1) ?? "")),
    ).toBe(true);
  });

  it("retains released optional outputs and respects private QA and bounded selectors", () => {
    const env = { OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: "0" };
    const selected = collectSourceCheckoutPluginBuildEntries({ env });
    expect(selected.some(({ id }) => id === "qa-lab")).toBe(false);
    expect(selected.find(({ id }) => id === "msteams")).toMatchObject({
      isolated: true,
      runtimeExtension: ".cjs",
    });
    const privateQa = collectSourceCheckoutPluginBuildEntries({
      env: { ...env, OPENCLAW_BUILD_PRIVATE_QA: "1" },
    });
    expect(privateQa.find(({ id }) => id === "qa-lab")).toMatchObject({
      isolated: false,
      runtimeExtension: ".js",
    });
    expect(
      collectSourceCheckoutPluginBuildEntries({
        env: { OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "telegram" },
      }).map(({ id }) => id),
    ).toEqual(["telegram"]);
  });

  it("agrees on Docker compiler, metadata, and readiness outputs without unselected excluded plugins", () => {
    const repoRoot = makeRepo("docker-plugin-format", {
      name: undefined,
      files: ["dist/**", "!dist/extensions/demo/**", "!dist/extensions/unselected/**"],
    });
    const pluginIds = ["demo", "unselected", "packaged"];
    for (const id of pluginIds) {
      const pluginRoot = makePlugin(
        repoRoot,
        id,
        {
          setupEntry: "./setup-entry.ts",
          build: { bundledDist: id !== "demo", runtimeFormat: "cjs" },
          channel: { id, ...channelStateFixtures },
          release: { publishToNpm: true },
        },
        { "setup-entry.ts": "export {};\n" },
        { name: undefined, version: undefined, type: undefined },
      );
      writeChannelStateFixtures(pluginRoot);
    }
    // Evaluate the real compiler config against synthetic plugins. These links
    // expose existing read-only config inputs; no core graph is compiled.
    for (const input of [
      "packages",
      "src",
      "node_modules",
      "extensions/browser",
      "extensions/anthropic",
    ]) {
      fs.symlinkSync(path.resolve(input), path.join(repoRoot, input), "dir");
    }
    const env = { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "demo" };
    const compiler = spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--input-type=module",
        "--eval",
        `
        import { pathToFileURL } from "node:url";
        const { default: configs } = await import(pathToFileURL(process.argv[1]).href);
        const entries = configs
          .filter((config) => config.name === "openclaw-unified")
          .flatMap((config) => Object.keys(config.entry));
        const ids = new Set(JSON.parse(process.argv[2]));
        console.log(JSON.stringify(entries.filter((key) =>
          key.startsWith("extensions/") && ids.has(key.split("/")[1])).sort()));
      `,
        path.resolve("tsdown.config.ts"),
        JSON.stringify(pluginIds),
      ],
      { cwd: repoRoot, env: { ...process.env, ...env }, encoding: "utf8" },
    );
    expect(compiler.status, compiler.stderr).toBe(0);
    const compilerEntries: string[] = JSON.parse(compiler.stdout);
    expect(compilerEntries).toEqual(
      ["demo", "packaged"].flatMap((id) =>
        ["auth-presence", "configured-state", "index", "setup-entry"].map(
          (entry) => `extensions/${id}/${entry}`,
        ),
      ),
    );
    const distRoot = path.join(repoRoot, "dist");
    writeFiles(
      distRoot,
      Object.fromEntries(compilerEntries.map((entry) => [`${entry}.js`, "export {};\n"])),
    );
    copyMetadata(repoRoot, env);
    const builtPackage = readJson(distRoot, "extensions/demo/package.json");
    const { extensions, setupEntry, channel } = builtPackage.openclaw;
    expect({ extensions, setupEntry, channel }).toEqual({
      extensions: ["./index.js"],
      setupEntry: "./setup-entry.js",
      channel: { id: "demo", ...builtChannelState(".js") },
    });
    expect(fs.existsSync(path.join(distRoot, "extensions/unselected"))).toBe(false);
    expect(listExternalPluginLocalDistPackageDirs({ repoRoot, env })).toEqual([]);
    expect(resolveBuildRequirement(buildReadiness(repoRoot, env))).toEqual({
      shouldBuild: false,
      reason: "clean",
    });
  });

  it("performs no writes when Docker owns the selected build", async () => {
    await expect(
      buildExternalPluginLocalDist({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,whatsapp",
        },
        logLevel: "silent",
      }),
    ).resolves.toMatchObject({ pluginDirs: [] });
  });
});
