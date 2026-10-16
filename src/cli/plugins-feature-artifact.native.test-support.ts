import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after as afterAll, afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { extract } from "tar";
import {
  validatePackageExtensionEntriesForInstall,
  resolvePackageRuntimeExtensionSources,
  resolvePackageSetupSource,
} from "../plugins/package-entry-resolution.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getCachedPluginModuleLoader } from "../plugins/plugin-module-loader-cache.js";
import { buildPluginLoaderAliasMap } from "../plugins/sdk-alias.js";
import { defaultRuntime } from "../runtime.js";
import {
  collectPluginsValidationResult,
  loadToolPlugin,
  runPluginsBuildCommand,
  runPluginsInitCommand,
} from "./plugins-authoring-command.js";
import {
  createPluginImportFixture,
  unresolvedPluginImportCases,
} from "./plugins-build-bundle.test-support.js";
import { runPluginsPackCommand } from "./plugins-feature-artifact.js";

const originalWriteJson = defaultRuntime.writeJson;
const directories: string[] = [];
let pristineParent: string | undefined;
let pristineFixturePromise: Promise<string> | undefined;

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

async function unpack(archive: string, parent: string, name = "extracted") {
  const cwd = path.join(parent, name);
  await fs.mkdir(cwd);
  await extract({ file: archive, cwd, strict: true });
  return path.join(cwd, "package");
}

const readJson = async (root: string, name: string) => JSON.parse(await readText(root, name));
const readText = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");
const browserModule = (root: string, entry: string) =>
  import(pathToFileURL(path.join(root, entry)).href);
function captureJson() {
  const output: unknown[] = [];
  defaultRuntime.writeJson = (value) => {
    output.push(value);
  };
  return output;
}
const bundleOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["openclaw/*"],
  logLevel: "silent",
} satisfies Parameters<typeof build>[0];
function installedEntry(
  packageDir: string,
  manifest: Parameters<typeof resolvePackageSetupSource>[0]["manifest"],
  extensions: string[],
) {
  const resolution = {
    packageDir,
    manifest,
    origin: "global" as const,
    sourceLabel: packageDir,
    diagnostics: [],
  };
  const [entryPath] = resolvePackageRuntimeExtensionSources({ ...resolution, extensions });
  return { resolution, entryPath: entryPath! };
}
async function expectPackRejected(
  root: string,
  out: string,
  error: Parameters<typeof assert.rejects>[1],
) {
  await assert.rejects(runPluginsPackCommand({ root, out }), error);
  await assert.rejects(fs.stat(out), { code: "ENOENT" });
}

function sourceLoader(entryPath: string) {
  return getCachedPluginModuleLoader({
    modulePath: entryPath,
    importerUrl: import.meta.url,
    aliasMap: buildPluginLoaderAliasMap(entryPath, process.argv[1], import.meta.url, "src"),
    tryNative: false,
  });
}
afterEach(async () => {
  defaultRuntime.writeJson = originalWriteJson;
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await pristineFixturePromise?.catch(() => undefined);
  if (pristineParent) {
    await fs.rm(pristineParent, { recursive: true, force: true });
  }
});

async function createPristineFixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feature-pack-seed-"));
  pristineParent = parent;
  const rootDir = path.join(parent, "draft-review");
  await runPluginsInitCommand("draft-review", { directory: rootDir, type: "feature" });
  await fs.symlink(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "dir");
  await build({
    ...bundleOptions,
    absWorkingDir: rootDir,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  });
  await fs.writeFile(
    path.join(rootDir, "dist/name.cjs"),
    'module.exports = require("node:path").basename("/fixtures/Draft Review");',
  );
  await fs.appendFile(
    path.join(rootDir, "dist/index.js"),
    '\nimport label from "./name.cjs"; if (label !== "Draft Review") throw new Error("CommonJS dependency failed");\n' +
      'const __dirname = "local"; const resourceNames = { __filename: "import.meta.url" }; if (__dirname !== "local" || !resourceNames.__filename) throw new Error("Local resource names failed");\n',
  );
  await runPluginsBuildCommand({ root: rootDir });
  return rootDir;
}

async function fixture() {
  const pristineRoot = await (pristineFixturePromise ??= createPristineFixture());
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feature-pack-"));
  directories.push(parent);
  const rootDir = path.join(parent, "draft-review");
  await fs.cp(pristineRoot, rootDir, { recursive: true, verbatimSymlinks: true });
  // Preserve the per-path module cache established by the original build before case mutations.
  await loadToolPlugin({ rootDir, entryPath: path.join(rootDir, "dist/index.js") });
  return { rootDir, parent };
}

// node:test owns registration completion and failure reporting.
function runCases<T>(
  cases: readonly T[],
  name: (value: T) => string,
  run: (value: T) => Promise<void>,
) {
  for (const value of cases) {
    void it(name(value), () => run(value));
  }
}

function hasMessage(message: string) {
  return (error: unknown) => error instanceof Error && error.message.includes(message);
}

void describe("plugin artifact authoring", () => {
  void it("packs CommonJS dependencies into a self-contained artifact bound to its exact digest", async () => {
    const { rootDir, parent } = await fixture();
    await fs.appendFile(
      path.join(rootDir, "dist/index.js"),
      '\nexport const __openclawCreateRequire = 1; export const createRequire = "author"; export const require = (name) => "local:" + name; export const globalThis = "author-global";\n' +
        'if (__openclawCreateRequire !== 1 || createRequire !== "author" || require("value") !== "local:value" || globalThis !== "author-global") throw new Error("Author bindings changed");\n',
    );
    await fs.appendFile(
      path.join(rootDir, "dist/name.cjs"),
      '\nif (typeof require("openclaw/plugin-sdk/feature-plugin").defineFeaturePlugin !== "function") throw new Error("CommonJS SDK dependency failed");\n',
    );
    const jsonOutput = captureJson();
    const archive = path.join(await fs.realpath(rootDir), "draft-review.tgz");
    await runPluginsPackCommand({ root: rootDir, json: true });
    const bytes = await fs.readFile(archive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(jsonOutput, [
      {
        path: archive,
        sha256,
        pluginId: "draft-review",
        bytes: bytes.length,
        activation: { action: "plugin_activate_artifact", path: archive, sha256 },
      },
    ]);
    const packageRoot = await unpack(archive, parent);
    const metadata = await readJson(packageRoot, "package.json");
    assert.deepEqual(
      [metadata.dependencies, metadata.scripts, metadata.openclaw.controlUi],
      [undefined, undefined, undefined],
    );
    const manifest = await readJson(packageRoot, "openclaw.plugin.json");
    assert.ok((await readText(packageRoot, manifest.controlUi.entry)).includes("Draft composer"));
    assert.deepEqual(await collectPluginsValidationResult({ root: packageRoot }), {
      valid: true,
      pluginId: "draft-review",
      errors: [],
    });
    assert.deepEqual(manifest.contracts.tools, ["draft_review_analyze"]);
    const sourcePackageRoot = await unpack(archive, parent, "source-extracted");
    const sourceEntryPath = path.join(sourcePackageRoot, "dist/index.js");
    // A separate plugin extraction exercises transformation while its SDK stays
    // on the canonical source host graph.
    const sourceLoaded = withPluginCache(createPluginCache(), () =>
      sourceLoader(sourceEntryPath)(sourceEntryPath),
    );
    assert.partialDeepStrictEqual(sourceLoaded, {
      __openclawCreateRequire: 1,
      createRequire: "author",
      globalThis: "author-global",
      default: { id: "draft-review" },
    });
    await fs.writeFile(path.join(rootDir, "src/control-ui.ts"), "export default null;");
    assert.deepEqual(await fs.readFile(archive), bytes);
  });

  runCases(
    [
      { id: "inferred-tools", filename: "inferred-tools.tgz", inferred: true, setup: true },
      { id: "@author/tools", filename: "@author__tools.tgz" },
      { id: "runtime-tools", filename: "runtime-tools.tgz", runtime: true },
      { id: "setup-tools", filename: "setup-tools.tgz", runtime: true, setup: true },
    ],
    ({ id }) => `packs ${id} with its installed runtime and metadata intact`,
    async ({ id, filename, runtime = false, setup = false, inferred = false }) => {
      const parent = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-pack-")),
      );
      directories.push(parent);
      const rootDir = path.join(parent, "project");
      await fs.mkdir(path.join(rootDir, "dist"), { recursive: true });
      await fs.symlink(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "dir");
      const packageManifest = {
        name: id,
        version: "1.0.0",
        type: "module",
        openclaw: {
          extensions: [inferred ? "./src/index.ts" : "./dist/index.js"],
          runtimeExtensions: runtime ? ["./dist/compiled.js"] : undefined,
          setupEntry: setup ? "./dist/setup-source.js" : undefined,
          runtimeSetupEntry: setup && runtime ? "./dist/setup-runtime.js" : undefined,
          compat: { pluginApi: ">=2026.5.17" },
        },
      };
      const entry = (
        marker: string,
        sharedPath = "./shared.js",
      ) => `import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { shared } from ${JSON.stringify(sharedPath)}; shared.ready = true;
export default Object.assign(defineToolPlugin({ id: ${JSON.stringify(id)}, name: "Packed tool", description: "Artifact fixture", tools: (tool) => [tool({ name: "artifact_echo", description: "Echo", optional: true, parameters: { type: "object", properties: {} }, execute: async () => ({ ok: true }) })] }), { artifactMarker: ${JSON.stringify(marker)}, shared });`;
      await writeFiles(rootDir, {
        "package.json": JSON.stringify(packageManifest),
        "dist/shared.js": "export const shared = { ready: false };",
        "dist/index.js": entry(inferred ? "runtime" : "source"),
        ...(inferred ? { "src/index.ts": entry("source", "../dist/shared.js") } : {}),
        ...(runtime ? { "dist/compiled.js": entry("runtime") } : {}),
        ...(setup
          ? Object.fromEntries(
              ["source", "runtime"].map((marker) => [
                `dist/setup-${marker}.js`,
                `import { shared } from "./shared.js"; export default { artifactMarker: "setup-${marker}", shared };`,
              ]),
            )
          : {}),
      });
      await runPluginsBuildCommand({ root: rootDir });
      const sourceManifest = await fs.readFile(path.join(rootDir, "openclaw.plugin.json"));
      const jsonOutput = captureJson();
      await runPluginsPackCommand({ root: rootDir, json: true });
      const archive = path.join(rootDir, filename);
      assert.partialDeepStrictEqual(jsonOutput.at(-1), { pluginId: id, path: archive });
      const packageDir = await unpack(archive, parent);
      const manifest = await readJson(packageDir, "package.json");
      assert.deepEqual(
        await fs.readFile(path.join(packageDir, "openclaw.plugin.json")),
        sourceManifest,
      );
      assert.deepEqual(manifest.openclaw.compat, packageManifest.openclaw.compat);
      assert.deepEqual(
        await validatePackageExtensionEntriesForInstall({
          packageDir,
          manifest,
          extensions: manifest.openclaw.extensions,
        }),
        { ok: true },
      );
      const { entryPath } = installedEntry(packageDir, manifest, manifest.openclaw.extensions);
      const loaded = await loadToolPlugin({ rootDir: packageDir, entryPath });
      assert.partialDeepStrictEqual(loaded.entry, {
        artifactMarker: runtime || inferred ? "runtime" : "source",
      });
      assert.partialDeepStrictEqual(loaded.metadata, {
        id,
        tools: [{ name: "artifact_echo", optional: true }],
      });
      if (setup) {
        // Keep plugin entry evaluation independent while reusing the native host SDK.
        const sourcePackageDir = await unpack(archive, parent, "source-extracted");
        const { resolution, entryPath: sourceEntryPath } = installedEntry(
          sourcePackageDir,
          manifest,
          manifest.openclaw.extensions,
        );
        const setupPath = resolvePackageSetupSource(resolution);
        assert.ok(setupPath);
        withPluginCache(createPluginCache(), () => {
          const load = sourceLoader(sourceEntryPath);
          assert.partialDeepStrictEqual(load(sourceEntryPath), {
            default: { shared: { ready: true } },
          });
          assert.partialDeepStrictEqual(load(setupPath!), {
            default: {
              artifactMarker: runtime ? "setup-runtime" : "setup-source",
              shared: { ready: true },
            },
          });
        });
      }
      const files = await fs.readdir(path.join(packageDir, "dist"));
      assert.deepEqual(
        files.filter((file) => !file.startsWith("chunk-")).toSorted(),
        setup ? ["index.js", "setup.js"] : ["index.js"],
      );
      assert.equal(files.filter((file) => file.startsWith("chunk-")).length, setup ? 1 : 0);
    },
  );

  void it("rejects opaque prebundles with guidance to use the regular package-install flow", async () => {
    const { rootDir, parent } = await fixture();
    const result = await build({
      ...bundleOptions,
      absWorkingDir: rootDir,
      entryPoints: ["dist/index.js"],
      outfile: "dist/prebundled.js",
      write: false,
    });
    await fs.writeFile(path.join(rootDir, "dist/index.js"), result.outputFiles[0]!.contents);
    const archive = path.join(parent, "prebundled.tgz");
    await expectPackRejected(
      rootDir,
      archive,
      /Indirect calls to "require" will not be bundled[\s\S]*regular package-install flow/u,
    );
  });

  runCases(
    unresolvedPluginImportCases,
    ({ name }) => `rejects unresolved ${name} before producing an artifact`,
    async (testCase) => {
      const {
        file,
        expected = "required dependency",
        diagnostic = "will not be bundled",
      } = testCase;
      const { rootDir, parent } = await fixture();
      const runOriginal = await createPluginImportFixture(
        path.join(rootDir, "dist/runtime"),
        testCase,
      );
      await fs.appendFile(
        path.join(rootDir, "dist/index.js"),
        `\nexport { loadDependency } from "./runtime/${file}";\n`,
      );
      assert.equal(runOriginal(), expected);
      const archive = path.join(parent, "runtime-dependency.tgz");
      await expectPackRejected(rootDir, archive, hasMessage(diagnostic));
    },
  );

  void it("packs standard-builder lazy chunks for use without source or dependencies", async () => {
    const { rootDir, parent } = await fixture();
    const metadata = await readJson(rootDir, "package.json");
    const source = path.resolve(rootDir, metadata.openclaw.controlUi);
    await writeFiles(path.dirname(source), {
      [path.basename(source)]:
        'export async function loadPage() { return (await import("./lazy-page.js")).page; }',
      "lazy-page.js": 'export const page = "Packed page ready";',
    });
    await runPluginsBuildCommand({ root: rootDir });
    const archive = path.join(parent, "lazy-page.tgz");
    await runPluginsPackCommand({ root: rootDir, out: archive });
    const packageRoot = await unpack(archive, parent);
    const manifest = await readJson(packageRoot, "openclaw.plugin.json");
    const assets = await fs.readdir(path.dirname(path.join(packageRoot, manifest.controlUi.entry)));
    assert.ok(assets.some((name) => name.startsWith("chunk-")));
    const browser = await browserModule(packageRoot, manifest.controlUi.entry);
    assert.equal(await browser.loadPage(), "Packed page ready");
    await assert.rejects(fs.stat(path.join(packageRoot, "node_modules")), { code: "ENOENT" });
  });

  void it("preserves prebuilt browser dependencies without packing unrelated files", async () => {
    const { rootDir, parent } = await fixture();
    const packagePath = path.join(rootDir, "package.json");
    const metadata = await readJson(rootDir, "package.json");
    delete metadata.openclaw.controlUi;
    await fs.writeFile(packagePath, JSON.stringify(metadata));
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    const manifest = await readJson(rootDir, "openclaw.plugin.json");
    const directory = "dist/control-ui/prebuilt";
    manifest.controlUi = {
      entry: `${directory}/index.js`,
      styles: [`${directory}/theme.css`],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const files = {
      "index.js":
        'import { prefix } from "./chunks/shared.mjs"; export default { id: "draft-review", async activate() { return prefix + (await import("./chunks/lazy.js")).suffix; } };',
      "chunks/shared.mjs": 'export const prefix = "Prebuilt ";',
      "chunks/lazy.js": 'export const suffix = "ready";',
      "theme.css": '@import "./styles/palette.css"; .prebuilt { color: var(--accent); }',
      "styles/palette.css": ":root { --accent: red; }",
      "index.js.map": "private sourcemap",
      "source.ts": "private source",
      ".hidden.js": "private hidden file",
    };
    await writeFiles(path.join(rootDir, directory), files);
    const activate = async (packageRoot: string) => {
      const browser = await browserModule(packageRoot, manifest.controlUi.entry);
      return browser.default.activate();
    };
    assert.equal(await activate(rootDir), "Prebuilt ready");

    const archive = path.join(parent, "prebuilt.tgz");
    await runPluginsPackCommand({ root: rootDir, out: archive });
    const packageRoot = await unpack(archive, parent);
    assert.equal(await activate(packageRoot), "Prebuilt ready");
    for (const name of ["theme.css", "styles/palette.css"] as const) {
      assert.equal(await readText(path.join(packageRoot, directory), name), files[name]);
    }
    for (const name of ["index.js.map", "source.ts", ".hidden.js"]) {
      await assert.rejects(fs.stat(path.join(packageRoot, directory, name)), {
        code: "ENOENT",
      });
    }
  });

  runCases(
    [
      {
        name: "ES module URL",
        file: "resource.mjs",
        source:
          'import { readFileSync } from "node:fs"; export const resource = readFileSync(new URL("./template.txt", import.meta.url), "utf8");',
      },
      {
        name: "CommonJS directory",
        file: "resource.cjs",
        source:
          'exports.resource = require("node:fs").readFileSync(require("node:path").join(__dirname, "template.txt"), "utf8");',
      },
      {
        name: "CommonJS filename",
        file: "resource.cjs",
        source:
          'exports.resource = require("node:fs").readFileSync(require("node:path").join(require("node:path").dirname(__filename), "template.txt"), "utf8");',
      },
    ],
    ({ name }) => `rejects backend resources located by ${name} before producing an artifact`,
    async ({ file, source }) => {
      const { rootDir, parent } = await fixture();
      const resources = path.join(rootDir, "dist/runtime");
      await writeFiles(resources, { "template.txt": "required template", [file]: source });
      await fs.appendFile(
        path.join(rootDir, "dist/index.js"),
        `\nimport { resource } from "./runtime/${file}"; if (resource !== "required template") throw new Error("Backend resource failed");\n`,
      );
      assert.deepEqual(await collectPluginsValidationResult({ root: rootDir }), {
        valid: true,
        pluginId: "draft-review",
        errors: [],
      });
      const archive = path.join(parent, "runtime-resource.tgz");
      await expectPackRejected(rootDir, archive, hasMessage("module-relative runtime files"));
    },
  );

  void it("rejects stale browser source and never overwrites an existing approval artifact", async () => {
    const { rootDir, parent } = await fixture();
    const out = path.join(parent, "review.tgz");
    await fs.writeFile(out, "existing review");
    await assert.rejects(runPluginsPackCommand({ root: rootDir, out }), {
      code: "EEXIST",
    });
    assert.equal(await fs.readFile(out, "utf8"), "existing review");
    await fs.writeFile(path.join(rootDir, "src/control-ui.ts"), "export default null;");
    await assert.rejects(runPluginsPackCommand({ root: rootDir }), hasMessage("missing or stale"));
    await assert.rejects(fs.stat(path.join(rootDir, "draft-review.tgz")), {
      code: "ENOENT",
    });
  });
});
