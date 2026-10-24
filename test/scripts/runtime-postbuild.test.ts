import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create as createTar } from "tar";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { collectPackageDistImportErrors } from "../../scripts/lib/package-dist-imports.mjs";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsToRuntimeOverlay,
  discoverStaticExtensionAssets,
} from "../../scripts/lib/static-extension-assets.mts";
import {
  parseUpdateCompatibilityInventory,
  readUpdateCompatibilityInventory,
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
  type UpdateCompatibilityInventory,
  type UpdateCompatibilityRelease,
} from "../../scripts/lib/update-compat-chunks.mts";
import {
  buildUpdateConfigRuntimeAlias,
  isUpdateConfigRuntimeAlias,
} from "../../scripts/lib/update-config-runtime-compat.mts";
import {
  listCoreRuntimePostBuildOutputs,
  rewriteRootRuntimeImportsToStableAliases,
  runRuntimePostBuild,
  writeLegacyCliExitCompatChunks,
  writeLegacyRootRuntimeCompatAliases,
  writeStableRootRuntimeAliases,
} from "../../scripts/runtime-postbuild.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../src/version.js";
import { createScriptTestHarness } from "./test-helpers.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const testNodeExecPath = resolveTestNodeExecPath();
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nodeRunnerFixture = `export { resolveNodeRunner } from ${JSON.stringify(new URL("../../src/cli/update-cli/node-runner.ts", import.meta.url).href)};\n`;

async function expectPathMissing(targetPath: string): Promise<void> {
  const result = fs.stat(targetPath);
  await expect(result).rejects.toBeInstanceOf(Error);
  await expect(result).rejects.toMatchObject({ code: "ENOENT" });
}

async function writeText(root: string, relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
}

const readText = (root: string, relative: string) => fs.readFile(path.join(root, relative), "utf8");
const load = (root: string, relative: string) =>
  import(pathToFileURL(path.join(root, relative)).href);

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    await writeText(root, name, contents);
  }
}

function postbuild(rootDir: string, options: Parameters<typeof runRuntimePostBuild>[0] = {}) {
  runRuntimePostBuild({ rootDir, timings: false, ...options });
}

function assetPackage(
  source: string,
  output = source,
  options: { name?: string; entry?: string; external?: boolean; dependency?: string } = {},
) {
  return JSON.stringify({
    name: options.name ?? "@openclaw/diffs",
    ...(options.dependency ? { dependencies: { [options.dependency]: "1.0.0" } } : {}),
    openclaw: {
      ...(options.external ? {} : { extensions: [options.entry ?? "./index.ts"] }),
      build: {
        staticAssets: [{ source, output }],
        ...(options.external ? { bundledDist: false } : {}),
      },
    },
  });
}

async function runtimeFixture(files: Record<string, string>) {
  const rootDir = createTempDir("openclaw-runtime-postbuild-");
  const distDir = path.join(rootDir, "dist");
  await fs.mkdir(distDir, { recursive: true });
  await writeFiles(distDir, files);
  return { rootDir, distDir };
}

const sourceLines = (...lines: string[]) => `${lines.join("\n")}\n`;

async function writeExportHtmlBuildFixture(rootDir: string): Promise<void> {
  await writeFiles(rootDir, {
    "src/auto-reply/reply/export-html/template.html": "<html></html>\n",
    "package.json": "{}\n",
  });
  for (const [name, entry, exports, source] of [
    [
      "marked",
      "index.js",
      ".",
      'export const parse = () => "alternate-root-marked"; export const use = () => {};',
    ],
    [
      "highlight.js",
      "common.js",
      "./lib/common",
      'export default { marker: "alternate-root-highlight" };',
    ],
  ] as const) {
    await writeFiles(path.join(rootDir, "node_modules", name), {
      "package.json": JSON.stringify({
        name,
        type: "module",
        exports: { [exports]: `./${entry}`, "./package.json": "./package.json" },
      }),
      [entry]: `${source}\n`,
      LICENSE: `ALTERNATE ROOT ${name === "marked" ? "MARKED" : "HIGHLIGHT"} LICENSE\n`,
    });
  }
}

describe("runtime postbuild static assets", () => {
  it("closes private CLI diagnostic imports without adding public-build companions", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-cli-");
    writeUpdateCompatibilityBuildFixture(rootDir);
    const companions = [
      "cli-process-diagnostics.test-support.cjs",
      "cli-process-tree.test-support.cjs",
    ];
    await fs.mkdir(path.join(rootDir, "src/cli"), { recursive: true });
    for (const fileName of companions) {
      await fs.copyFile(
        path.join(MODULE_ROOT, "src/cli", fileName),
        path.join(rootDir, "src/cli", fileName),
      );
    }
    const params = {
      rootDir,
      env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" },
      timings: false,
    };
    runRuntimePostBuild(params);
    for (const fileName of companions) {
      await expectPathMissing(path.join(rootDir, "dist", fileName));
    }
    await fs.mkdir(path.join(rootDir, "dist/plugin-sdk"), { recursive: true });
    await writeFiles(rootDir, {
      "dist/plugin-sdk/test-env.js": 'export * from "../test-env-fixture.mjs";\n',
      "dist/test-env-fixture.mjs": companions
        .map((fileName) => `new URL("./${fileName}", import.meta.url);`)
        .join("\n"),
    });
    runRuntimePostBuild(params);
    const files = fsSync.readdirSync(path.join(rootDir, "dist")).map((name) => `dist/${name}`);
    expect(
      collectPackageDistImportErrors({
        files: files.filter(
          (name) => name.endsWith(".cjs") || name === "dist/test-env-fixture.mjs",
        ),
        readText: (file: string) => fsSync.readFileSync(path.join(rootDir, file), "utf8"),
      }),
    ).toEqual([]);
    for (const fileName of companions) {
      await fs.unlink(path.join(rootDir, "dist", fileName));
      expect(listCoreRuntimePostBuildOutputs({ rootDir })).toContain(`dist/${fileName}`);
    }
  });

  it("copies bundled hook metadata without replacing compiled handlers", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-hooks-");
    writeUpdateCompatibilityBuildFixture(rootDir);
    const sourceHookDir = path.join(rootDir, "src/hooks/bundled/session-memory");
    const distHookDir = path.join(rootDir, "dist/bundled/session-memory");
    await writeText(sourceHookDir, "HOOK.md", "---\nname: session-memory\n---\n");
    await writeText(distHookDir, "handler.js", "export default () => {};\n");

    postbuild(rootDir, { env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" } });

    await expect(readText(distHookDir, "HOOK.md")).resolves.toContain("name: session-memory");
    await expect(readText(distHookDir, "handler.js")).resolves.toBe("export default () => {};\n");
  });

  it("discovers repo static asset metadata without scanning extension directories", () => {
    const payload = expectNoNodeFsScans<string[]>(
      `
      const assets = await import("./scripts/lib/static-extension-assets.mts");
      return assets.discoverStaticExtensionAssets().map(({ dest }) => dest);
    `,
      { allowedExistsSyncPaths: [path.join(MODULE_ROOT, ".git")] },
    );
    expect(payload.length).toBeGreaterThan(0);
  });

  it("ships the PostgreSQL schema read by the packaged Logbook port descriptor", async () => {
    const rootDir = createTempDir("openclaw-logbook-port-assets-");
    const pluginPath = "extensions/logbook";
    const schemaPath = `${pluginPath}/src/logbook-schema.postgres.sql`;
    for (const relativePath of [`${pluginPath}/package.json`, schemaPath]) {
      const destination = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(MODULE_ROOT, relativePath), destination);
    }
    await fs.mkdir(path.join(rootDir, "dist-runtime/extensions"), { recursive: true });

    copyStaticExtensionAssets({ rootDir });
    copyStaticExtensionAssetsToRuntimeOverlay({ rootDir });

    const schema = await readText(MODULE_ROOT, schemaPath);
    for (const outputRoot of ["dist", "dist-runtime"]) {
      await expect(readText(rootDir, path.join(outputRoot, schemaPath))).resolves.toBe(schema);
    }
  });

  it("copies each package asset once with multiple Git index stages", async () => {
    const rootDir = createTempDir("openclaw-static-assets-index-");
    const git = (args: string[], input?: string) =>
      childProcess.execFileSync("git", args, { cwd: rootDir, encoding: "utf8", input });
    const pluginIds = ["conflicted", "package-only", "with-manifest"];
    for (const id of pluginIds) {
      const pluginDir = path.join(rootDir, "extensions", id);
      await fs.mkdir(pluginDir, { recursive: true });
      await writeFiles(pluginDir, {
        "asset.txt": `${id} bytes\n`,
        "package.json": JSON.stringify({
          openclaw: { build: { staticAssets: [{ source: "asset.txt", output: "asset.txt" }] } },
        }),
      });
    }
    for (const id of ["with-manifest", "manifest-only"]) {
      const pluginDir = path.join(rootDir, "extensions", id);
      await fs.mkdir(pluginDir, { recursive: true });
      await writeText(pluginDir, "openclaw.plugin.json", "not valid JSON");
    }
    git(["init", "-q"]);
    git(["add", "extensions"]);
    const packagePath = "extensions/conflicted/package.json";
    const blob = git(["hash-object", "-w", "--stdin"], "{}").trim();
    // Keep resolved working-tree metadata while the index still holds all merge stages.
    git(
      ["update-index", "--index-info"],
      sourceLines(
        `0 ${"0".repeat(blob.length)}\t${packagePath}`,
        ...[1, 2, 3].map((stage) => `100644 ${blob} ${stage}\t${packagePath}`),
      ),
    );
    const copy = vi.spyOn(fsSync, "copyFileSync");
    try {
      copyStaticExtensionAssets({ rootDir });
      expect(copy).toHaveBeenCalledTimes(3);
      expect(discoverStaticExtensionAssets({ rootDir }).map(({ pluginDir }) => pluginDir)).toEqual(
        pluginIds,
      );
      for (const id of pluginIds) {
        await expect(
          readText(rootDir, path.join("dist", "extensions", id, "asset.txt")),
        ).resolves.toBe(`${id} bytes\n`);
      }
    } finally {
      copy.mockRestore();
    }
  });

  it.each([
    { name: "top-level array", packageJson: [] },
    { name: "array openclaw section", packageJson: { openclaw: [] } },
    { name: "array build section", packageJson: { openclaw: { build: [] } } },
    {
      name: "non-record asset entries",
      packageJson: {
        openclaw: { build: { staticAssets: [[], "asset", null, { source: 42, output: [] }] } },
      },
    },
  ])("ignores malformed $name metadata", async ({ packageJson }) => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-malformed-");
    const packageDir = path.join(rootDir, "extensions/demo");
    await writeText(packageDir, "package.json", JSON.stringify(packageJson));

    expect(discoverStaticExtensionAssets({ rootDir })).toEqual([]);
  });

  it.each([
    { name: "normal root build", params: {}, included: false },
    { name: "isolated external build", params: { includeExternalPlugins: true }, included: true },
    {
      name: "Docker-selected build",
      params: { env: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: "external-demo" } },
      included: true,
    },
  ])("$name handles external plugin assets", async ({ params, included }) => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const packageDir = path.join(rootDir, "extensions/external-demo");
    await writeText(
      packageDir,
      "package.json",
      assetPackage("./assets/runtime.js", "assets/runtime.js", {
        name: "@openclaw/external-demo",
        external: true,
      }),
    );

    expect(discoverStaticExtensionAssets({ rootDir, ...params })).toEqual(
      included
        ? [
            {
              pluginDir: "external-demo",
              src: "extensions/external-demo/assets/runtime.js",
              dest: "dist/extensions/external-demo/assets/runtime.js",
            },
          ]
        : [],
    );
  });

  it.each([
    ["package-relative source", "", false, false],
    ["hoisted dependency", "engine", false, false],
    ["hoisted scoped dependency", "@fixture/engine", false, false],
    ["plugin-local dependency precedence", "@fixture/engine", true, false],
    ["missing asset in selected dependency", "@fixture/engine", true, true],
  ] as const)(
    "stages %s during the same postbuild run",
    async (_name, dependency, local, missing) => {
      const rootDir = createTempDir("openclaw-runtime-postbuild-");
      const output = "assets/viewer-runtime.js";
      const source = dependency ? `node_modules/${dependency}/private/runtime.js` : output;
      const packageDir = path.join(rootDir, "extensions/diffs");
      const distAsset = "dist/extensions/diffs/assets/viewer-runtime.js";
      const runtimeAsset = "dist-runtime/extensions/diffs/assets/viewer-runtime.js";
      const contents = "export const viewer = true;\n";
      const warn = vi.fn();

      await writeFiles(rootDir, {
        "extensions/diffs/package.json": assetPackage(`./${source}`, output, {
          dependency,
        }),
        "extensions/diffs/openclaw.plugin.json": '{"id":"diffs"}\n',
      });
      if (dependency) {
        for (const base of local ? [rootDir, packageDir] : [rootDir]) {
          const dependencyDir = path.join(base, "node_modules", dependency);
          await writeText(
            dependencyDir,
            "package.json",
            JSON.stringify({ name: dependency, exports: { "./runtime": "./private/runtime.js" } }),
          );
          if (!(missing && base === packageDir)) {
            await writeText(
              dependencyDir,
              "private/runtime.js",
              local && base === rootDir ? "wrong ancestor version\n" : contents,
            );
          }
        }
      } else {
        await writeText(packageDir, source, contents);
      }

      writeUpdateCompatibilityBuildFixture(rootDir);
      postbuild(rootDir, { warn });

      for (const asset of [distAsset, runtimeAsset]) {
        if (missing) {
          await expectPathMissing(path.join(rootDir, asset));
        } else {
          await expect(readText(rootDir, asset)).resolves.toBe(contents);
        }
      }
      if (missing) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("static asset not found"));
      }
    },
  );

  it.each(["cwd", "rootDir"])(
    "writes every phase beneath the %s caller root",
    async (selection) => {
      const rootDir = createTempDir("openclaw-runtime-postbuild-cwd-");
      const rejected =
        selection === "rootDir"
          ? [createTempDir("rejected-cwd-"), createTempDir("rejected-repo-")]
          : [];
      await writeExportHtmlBuildFixture(rootDir);
      writeUpdateCompatibilityBuildFixture(rootDir);
      await writeText(rootDir, "dist/cli/update-cli/node-runner.js", nodeRunnerFixture);
      runRuntimePostBuild({
        ...(selection === "rootDir"
          ? { rootDir, cwd: rejected[0], repoRoot: rejected[1] }
          : { cwd: rootDir }),
        env: {
          OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0",
          OPENCLAW_CONTROL_UI_BUILD_ID: "source-runtime-build",
        },
        timings: false,
      });

      expect(
        readBuildIdFromBuildInfoForModuleUrl(
          pathToFileURL(path.join(rootDir, "dist/entry.js")).href,
        ),
      ).toBe("source-runtime-build");
      await expect(readText(rootDir, "dist/export-html/template.html")).resolves.toBe(
        "<html></html>\n",
      );
      const vendorDir = path.join(rootDir, "dist/export-html/vendor");
      const markedAsset = await readText(vendorDir, "marked.min.js");
      const highlightAsset = await readText(vendorDir, "highlight.min.js");
      expect(markedAsset).toContain("ALTERNATE ROOT MARKED LICENSE");
      expect(markedAsset).toContain("alternate-root-marked");
      expect(highlightAsset).toContain("ALTERNATE ROOT HIGHLIGHT LICENSE");
      expect(highlightAsset).toContain("alternate-root-highlight");
      await expect(readText(rootDir, "dist/channel-catalog.json")).resolves.toContain('"entries"');
      const bridge = await load(rootDir, "dist/shared-Y6bNiw2w.js");
      expect(bridge.resolveNodeRunner()).toBe(process.execPath);
      for (const root of rejected) {
        await expectPathMissing(path.join(root, "dist"));
      }
    },
  );

  it("validates every postbuild root before running any phase", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-roots-");
    const distFile = path.join(rootDir, "dist", "keep.js");
    const targetDir = path.join(rootDir, "gateway-runtime");
    await fs.mkdir(path.dirname(distFile), { recursive: true });
    await fs.mkdir(targetDir);
    await fs.writeFile(distFile, "keep\n");
    await fs.symlink(targetDir, path.join(rootDir, "dist-runtime"), "dir");

    expect(() =>
      runRuntimePostBuild({ cwd: rootDir, repoRoot: rootDir, rootDir, timings: false }),
    ).toThrow(/symbolic link/u);

    await expect(fs.readdir(path.join(rootDir, "dist"))).resolves.toEqual(["keep.js"]);
    await expect(fs.readFile(distFile, "utf8")).resolves.toBe("keep\n");
  });

  it("preserves restored dist static assets when plugin sources are absent", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const output = "assets/viewer-runtime.js";
    const distPluginDir = path.join(rootDir, "dist/extensions/diffs");
    const runtimeAsset = path.join(rootDir, "dist-runtime/extensions/diffs", output);
    await writeFiles(distPluginDir, {
      "index.js": "export default {};\n",
      "openclaw.plugin.json": '{"id":"diffs"}\n',
      "package.json": assetPackage(`./${output}`, output, { entry: "./index.js" }),
      [output]: "console.log('viewer');\n",
    });

    writeUpdateCompatibilityBuildFixture(rootDir);
    postbuild(rootDir);

    await expect(fs.readFile(runtimeAsset, "utf8")).resolves.toBe("console.log('viewer');\n");
  });

  it("can skip static asset copies for minimal runtime builds", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    writeUpdateCompatibilityBuildFixture(rootDir);
    const warn = vi.fn();
    const output = "assets/viewer-runtime.js";

    await writeText(rootDir, "extensions/diffs/package.json", assetPackage(`./${output}`, output));

    postbuild(rootDir, { env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" }, warn });

    expect(warn).not.toHaveBeenCalled();
    await expectPathMissing(path.join(rootDir, "dist", "extensions", "diffs", output));
  });

  it.each([
    { rootPresent: false, output: "extensions" },
    { rootPresent: true, output: "other" },
  ])(
    "skips overlay assets with rootPresent=$rootPresent and output=$output",
    async ({ rootPresent, output }) => {
      const rootDir = createTempDir("openclaw-runtime-postbuild-");
      if (rootPresent) {
        await fs.mkdir(path.join(rootDir, "dist-runtime/extensions"), { recursive: true });
      }
      await writeText(rootDir, "extensions/demo/assets/viewer.js", "viewer\n");
      copyStaticExtensionAssetsToRuntimeOverlay({
        rootDir,
        assets: [
          { src: "extensions/demo/assets/viewer.js", dest: `dist/${output}/demo/assets/viewer.js` },
        ],
      });
      await expectPathMissing(path.join(rootDir, "dist-runtime", output, "demo/assets"));
    },
  );

  it("warns when a runtime overlay static asset source is missing", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-");
    const warn = vi.fn();
    await fs.mkdir(path.join(rootDir, "dist-runtime", "extensions"), { recursive: true });

    copyStaticExtensionAssetsToRuntimeOverlay({
      rootDir,
      assets: [
        {
          src: "extensions/demo/assets/missing.js",
          dest: "dist/extensions/demo/assets/missing.js",
        },
      ],
      warn,
    });

    expect(warn).toHaveBeenCalledWith(
      "[runtime-postbuild] static asset not found, skipping: extensions/demo/assets/missing.js",
    );
    await expectPathMissing(
      path.join(rootDir, "dist-runtime", "extensions", "demo", "assets", "missing.js"),
    );
  });

  it("refuses to rewrite stable aliases through a symlinked dist root", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-symlink-");
    const targetDir = path.join(rootDir, "gateway-dist");
    await fs.mkdir(targetDir, { recursive: true });
    const hashedFile = path.join(targetDir, "runtime-model-auth.runtime-XyZ987.js");
    await fs.writeFile(hashedFile, "export const auth = true;\n", "utf8");
    const distLink = path.join(rootDir, "dist");
    await fs.symlink(targetDir, distLink, "dir");

    expect(() => writeStableRootRuntimeAliases({ rootDir })).toThrow(/symbolic link/u);

    expect(await fs.readlink(distLink)).toBe(targetDir);
    expect(await fs.readFile(hashedFile, "utf8")).toBe("export const auth = true;\n");
    await expectPathMissing(path.join(targetDir, "runtime-model-auth.runtime.js"));
  });

  it("forwards default exports through stable and legacy aliases", async () => {
    const { rootDir, distDir } = await runtimeFixture({});
    await writeText(rootDir, "package.json", '{"type":"module"}\n');
    await writeFiles(distDir, {
      "text-transforms.runtime-Hash111.mjs":
        "function reconcile(value) { return value; }\nexport { reconcile as default };\n",
      "mixed.contract-Hash222.mjs":
        "export const named = true;\nexport default function run() {}\n",
      "named-only.runtime-Hash333.js":
        'const marker = "export { marker as default }";\nexport { marker };\n',
      "library-Other123.mjs": "export const x = true;\n",
    });

    writeStableRootRuntimeAliases({ rootDir });
    writeLegacyRootRuntimeCompatAliases({ rootDir });

    const stable = await load(distDir, "text-transforms.runtime.js");
    const legacy = await load(distDir, "text-transforms.runtime-sEqsN4pN.js");
    const mixed = await load(distDir, "mixed.contract.js");
    const namedOnly = await load(distDir, "named-only.runtime.js");

    expect(stable.default("stable")).toBe("stable");
    expect(legacy.default("legacy")).toBe("legacy");
    expect(mixed.default).toBeTypeOf("function");
    expect(mixed.named).toBe(true);
    expect(namedOnly.marker).toBe("export { marker as default }");
    expect(namedOnly).not.toHaveProperty("default");
    for (const file of ["library.js", "text-transforms.runtime.mjs", "mixed.contract.mjs"]) {
      await expectPathMissing(path.join(distDir, file));
    }

    rewriteRootRuntimeImportsToStableAliases({ rootDir });
    expect(await readText(distDir, "mixed.contract.js")).toBe(
      'export * from "./mixed.contract-Hash222.mjs";\n' +
        'export { default } from "./mixed.contract-Hash222.mjs";\n',
    );
    writeStableRootRuntimeAliases({ rootDir });
    writeLegacyRootRuntimeCompatAliases({ rootDir });
    expect(await readText(distDir, "text-transforms.runtime.js")).toBe(
      'export * from "./text-transforms.runtime-Hash111.mjs";\n' +
        'export { default } from "./text-transforms.runtime-Hash111.mjs";\n',
    );

    const stableAfterRerun = await import(
      `${pathToFileURL(path.join(distDir, "text-transforms.runtime.js")).href}?rerun=1`
    );
    expect(stableAfterRerun.default("rerun")).toBe("rerun");
  });

  it("keeps stable aliases when one colliding root runtime chunk re-exports the implementation", async () => {
    const { rootDir, distDir } = await runtimeFixture({
      "runtime-model-auth.runtime-Impl123.js": "export const auth = true;\n",
      "runtime-model-auth.runtime-Wrap456.mjs":
        'import { auth } from "./runtime-model-auth.runtime-Impl123.js";\nexport { auth };\n',
    });

    writeStableRootRuntimeAliases({ rootDir });

    expect(await readText(distDir, "runtime-model-auth.runtime.js")).toBe(
      'export * from "./runtime-model-auth.runtime-Wrap456.mjs";\n',
    );
  });

  it("ignores legacy wrappers to the stable runtime alias when choosing the implementation", async () => {
    const { rootDir, distDir } = await runtimeFixture({
      "runtime-plugins.runtime-NewHash.mjs": "export const ready = true;\n",
      "runtime-plugins.runtime-OldHash.js": 'export * from "./runtime-plugins.runtime.js";\n',
      "dispatch-OldHash.js": sourceLines(
        'const lazy = () => import("./runtime-plugins.runtime-NewHash.mjs");',
      ),
    });

    rewriteRootRuntimeImportsToStableAliases({ rootDir });
    writeStableRootRuntimeAliases({ rootDir });

    expect(await readText(distDir, "dispatch-OldHash.js")).toBe(
      sourceLines('const lazy = () => import("./runtime-plugins.runtime.js");'),
    );
    expect(await readText(distDir, "runtime-plugins.runtime.js")).toBe(
      'export * from "./runtime-plugins.runtime-NewHash.mjs";\n',
    );
  });

  it.each(["js", "mjs"])("rewrites mixed runtime imports in a %s importer", async (extension) => {
    const { rootDir, distDir } = await runtimeFixture({
      "runtime-plugins.runtime-AbCd1234.mjs": "export const ready = true;\n",
      "server-close.runtime-AbCd1234.js": "export const close = true;\n",
      "dispatch.contract-AbCd1234.js": "export const dispatch = true;\n",
    });
    const importerPath = path.join(distDir, `dispatch-OldHash.${extension}`);
    await fs.writeFile(
      importerPath,
      sourceLines(
        'const lazy = () => import("./runtime-plugins.runtime-AbCd1234.mjs");',
        'const closeModule = () => import("./server-close.runtime-AbCd1234.js");',
        'export { dispatch } from "./dispatch.contract-AbCd1234.js";',
        'import "./missing.runtime-Nope.js";',
        'import "./missing.contract-Nope.mjs";',
        'const ordinaryChunk = () => import("./server-close-OldHash.js");',
      ),
      "utf8",
    );

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await fs.readFile(importerPath, "utf8")).toBe(
      sourceLines(
        'const lazy = () => import("./runtime-plugins.runtime.js");',
        'const closeModule = () => import("./server-close.runtime.js");',
        'export { dispatch } from "./dispatch.contract.js";',
        'import "./missing.runtime-Nope.js";',
        'import "./missing.contract-Nope.mjs";',
        'const ordinaryChunk = () => import("./server-close-OldHash.js");',
      ),
    );
  });

  it("keeps text-transform runtime imports hashed after the stable alias export surface grew", async () => {
    const { rootDir, distDir } = await runtimeFixture({
      "text-transforms.runtime-NewHash.mjs": "export const n = true;\nexport const t = true;\n",
      "provider-runtime-NewHash.mjs": sourceLines(
        'import { n as applyPluginTextReplacements } from "./text-transforms.runtime-NewHash.mjs";',
        "export { applyPluginTextReplacements };",
      ),
    });

    rewriteRootRuntimeImportsToStableAliases({ rootDir });
    writeStableRootRuntimeAliases({ rootDir });

    expect(await readText(distDir, "provider-runtime-NewHash.mjs")).toBe(
      sourceLines(
        'import { n as applyPluginTextReplacements } from "./text-transforms.runtime-NewHash.mjs";',
        "export { applyPluginTextReplacements };",
      ),
    );
    expect(await readText(distDir, "text-transforms.runtime.js")).toBe(
      'export * from "./text-transforms.runtime-NewHash.mjs";\n',
    );
  });

  it("keeps hashed imports when a stable runtime alias would collide", async () => {
    const { rootDir, distDir } = await runtimeFixture({
      "install.runtime-Aaa111.mjs": "export const pluginInstall = true;\n",
      "install.runtime-Bbb222.js": "export const daemonInstall = true;\n",
      "install.runtime.js": 'export * from "./install.runtime-Stale.js";\n',
      "install-OldHash.js": sourceLines(
        'const pluginRuntime = () => import("./install.runtime-Aaa111.mjs");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
      ),
    });

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await readText(distDir, "install-OldHash.js")).toBe(
      sourceLines(
        'const pluginRuntime = () => import("./install.runtime-Aaa111.mjs");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
      ),
    );
    writeStableRootRuntimeAliases({ rootDir });
    await expectPathMissing(path.join(distDir, "install.runtime.js"));
  });

  it("rewrites plugin install runtime imports to stable aliases when install runtimes collide", async () => {
    const { rootDir, distDir } = await runtimeFixture({
      "install.runtime-Aaa111.mjs": sourceLines(
        "export const scanPackageInstallSource = true;",
        "export const scanInstalledPackageDependencyTree = true;",
        "export const scanBundleInstallSource = true;",
      ),
      "install.runtime-Bbb222.js": "export const daemonInstall = true;\n",
      "install-OldHash.js": sourceLines(
        'const pluginRuntime = () => import("./install.runtime-Aaa111.mjs");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
      ),
    });

    rewriteRootRuntimeImportsToStableAliases({ rootDir });

    expect(await readText(distDir, "install-OldHash.js")).toBe(
      sourceLines(
        'const pluginRuntime = () => import("./install.runtime.js");',
        'const daemonRuntime = () => import("./install.runtime-Bbb222.js");',
      ),
    );
    writeStableRootRuntimeAliases({ rootDir });
    expect(await readText(distDir, "install.runtime.js")).toBe(
      'export * from "./install.runtime-Aaa111.mjs";\n',
    );
  });

  it("keeps every recorded previous-release lazy import loadable after replacement", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-update-compat-");
    writeUpdateCompatibilityBuildFixture(rootDir);
    postbuild(rootDir, { env: { OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" } });

    for (const release of previousReleaseInventory.releases) {
      for (const chunk of release.chunks) {
        const loaded = await load(rootDir, `dist/${chunk.path}`);
        for (const { exported, origin } of chunk.exports) {
          expect(loaded[exported](), `${release.version}: ${chunk.path}:${exported}`).toBe(
            origin.symbol,
          );
        }
      }
    }
  });

  it("keeps the 2026.9.1 Git updater restart import loadable after dist replacement", async () => {
    const rootDir = createTempDir("openclaw-runtime-postbuild-old-updater-");
    await writeText(rootDir, "package.json", '{"type":"module"}');
    const distDir = path.join(rootDir, "dist");
    const ownerPath = path.join(distDir, "update-command-service-command.mjs");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      ownerPath,
      'export async function restart() { return (await import("./shared-1Uyqkfns.js")).resolveNodeRunner(); }\n',
    );
    const output = childProcess.execFileSync(
      testNodeExecPath,
      [
        "--import",
        path.join(MODULE_ROOT, "scripts/tsx.mjs"),
        "--input-type=module",
        "-e",
        [
          'import fs from "node:fs/promises";',
          'import path from "node:path";',
          'import { pathToFileURL } from "node:url";',
          `import { writeLegacyCliExitCompatChunks } from ${JSON.stringify(pathToFileURL(path.join(MODULE_ROOT, "scripts/runtime-postbuild.mts")).href)};`,
          "const rootDir = process.argv[1];",
          'const owner = await import(pathToFileURL(path.join(rootDir, "dist/update-command-service-command.mjs")).href);',
          'await fs.rm(path.join(rootDir, "dist"), { recursive: true, force: true });',
          'const runner = path.join(rootDir, "dist/cli/update-cli/node-runner.js");',
          "await fs.mkdir(path.dirname(runner), { recursive: true });",
          `await fs.writeFile(runner, ${JSON.stringify(nodeRunnerFixture)});`,
          "writeLegacyCliExitCompatChunks({ rootDir });",
          "process.stdout.write(await owner.restart());",
        ].join("\n"),
        rootDir,
      ],
      { encoding: "utf8" },
    );

    expect(output).toBe(testNodeExecPath);
  });

  it.each(["shared-Y6bNiw2w.js", "shared-DTaQo6Hi.js"])(
    "preserves the old updater node-runner ABI through %s",
    async (chunk) => {
      const rootDir = createTempDir("openclaw-runtime-postbuild-");
      const runner = path.join(rootDir, "dist/cli/update-cli/node-runner.js");
      await fs.mkdir(path.dirname(runner), { recursive: true });
      await fs.writeFile(runner, nodeRunnerFixture);

      writeLegacyCliExitCompatChunks({ rootDir });

      const bridge = await load(rootDir, `dist/${chunk}`);
      expect(bridge.resolveNodeRunner()).toBe(process.execPath);
    },
  );
});

describe("previous release update compatibility", () => {
  const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;

  function write(root: string, relative: string, contents: string): void {
    const file = path.join(root, relative);
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, contents);
  }

  function writeMany(root: string, files: Record<string, string>) {
    for (const [name, contents] of Object.entries(files)) {
      write(root, name, contents);
    }
  }

  function bridgeOptions(sourceDir: string, inventory: UpdateCompatibilityInventory) {
    return { distDir: path.join(sourceDir, "dist"), sourceDir, inventory };
  }

  function recordFixture(includePrivateWorker = false) {
    return recordImportedFixture(
      `await (async () => {
        (await import("./service-abcdefgh.js")).runner();
        const { mode: selected } = await import("./service-abcdefgh.js");
        return selected();
      })()`,
      {
        "service-abcdefgh.js":
          'export { r as runner, m as mode } from "./implementation-12345678.js";',
        "implementation-12345678.js": [
          "//#region src/cli/update-cli/runner.ts",
          'function resolveRunner() { return "old"; }',
          "//#region src/cli/update-cli/recovery.ts",
          'function resolveMode() { return "old"; }',
          "export { resolveRunner as r, resolveMode as m };",
        ].join("\n"),
        ...(includePrivateWorker
          ? {
              "state/openclaw-state-read.worker.js":
                '//#region src/cli/update-cli/update-command-service-command.ts\nexport async function restart() { return await import("./openclaw-state-read-service-abcdefgh.mjs"); }\n',
              "state/openclaw-state-read-command.mjs":
                '//#region src/daemon/inspect.ts\nexport async function inspect() { return await import("./openclaw-state-read-service-abcdefgh.mjs"); }\n',
              "state/openclaw-state-read-service-abcdefgh.mjs":
                '//#region src/cli/update-cli/runner.ts\nexport function resolveRunner() { return "private worker"; }\n',
            }
          : {}),
      },
    ).inventory;
  }

  function candidate(root: string): void {
    writeMany(root, {
      "src/cli/update-cli/recovery.ts": 'import { resolveMode } from "./mode.js";',
      "src/cli/update-cli/mode.ts": 'export function resolveMode() { return "npm"; }',
      "dist/current.mjs": [
        "//#region src/cli/update-cli/runner.ts",
        'function resolveRunner() { return "node"; }',
        "//#region src/cli/update-cli/mode.ts",
        'function resolveMode() { return "npm"; }',
        "export { resolveRunner as x, resolveMode as y };",
      ].join("\n"),
    });
  }

  function recordImportedFixture(
    expression: string,
    modules: Record<string, string>,
    identity: Pick<UpdateCompatibilityRelease, "version" | "buildId" | "commit" | "integrity"> = {
      version: "2026.9.1",
      buildId: "fixture",
      commit: "0".repeat(40),
      integrity,
    },
    owner = "src/cli/update-cli/update-command-service-command.ts",
  ) {
    const root = createTempDir("update-compat-import-graph-");
    writeMany(root, {
      "package.json": JSON.stringify({
        name: "openclaw",
        version: identity.version,
        type: "module",
      }),
      "dist/build-info.json": JSON.stringify(identity),
      "dist/command.js": [
        `//#region ${owner}`,
        `export async function restart() { return ${expression}; }`,
      ].join("\n"),
    });
    for (const [file, source] of Object.entries(modules)) {
      write(root, `dist/${file}`, source);
    }
    const inventory: UpdateCompatibilityInventory & { releases: [UpdateCompatibilityRelease] } = {
      schemaVersion: 1,
      releases: [
        recordUpdateCompatibilityRelease({ packageDir: root, integrity: identity.integrity }),
      ],
    };
    return { root, inventory };
  }

  it.each([
    "generated",
    "historical",
    "historical changed delegation",
    "historical changed binding",
    "historical changed target",
    "changed delegation",
    "missing source region",
  ])("traces only verified delegating config aliases (%s)", (variant) => {
    const facade =
      'export { createConfigIO, readConfigFileSnapshot } from "./config-abcdefgh.mjs";\nexport * from "./extra.mjs";\n';
    let alias = variant.startsWith("historical")
      ? fsSync.readFileSync(
          path.join(MODULE_ROOT, "test/fixtures/update-config-runtime-alias-2026.9.5.txt"),
          "utf8",
        )
      : buildUpdateConfigRuntimeAlias(
          "io.runtime-abcdefgh.mjs",
          parser.parseSourceFile("facade.mjs", facade),
        );
    if (variant.endsWith("changed delegation")) {
      alias = alias.replace("return runtime[name]", "return undefined");
    } else if (variant === "historical changed binding") {
      alias = alias.replace('select("createConfigIO")', 'select("readConfigFileSnapshot")');
    } else if (variant === "historical changed target") {
      alias = alias.replace('"./io.runtime-abcdefgh.mjs"', '"./"');
      // Verify the alias owner independently of ModuleGraph's target-name guard.
      expect(
        isUpdateConfigRuntimeAlias(
          alias,
          "io.runtime-abcdefgh.mjs",
          parser.parseSourceFile("facade.mjs", facade),
        ),
      ).toBe(false);
    }
    const record = () =>
      recordImportedFixture('(await import("./io.runtime.js"))', {
        "io.runtime.js": alias,
        "io.runtime-abcdefgh.mjs": facade,
        "extra.mjs": "//#region src/config/extra.ts\nexport const targetOnly = true;\n",
        "config-abcdefgh.mjs": [
          'throw new Error("The recorder must not execute release code");',
          ...(variant === "missing source region" ? [] : ["//#region src/config/io.ts"]),
          "export function createConfigIO() {}",
          "export function readConfigFileSnapshot() {}",
        ].join("\n"),
      });
    if (variant !== "generated" && variant !== "historical") {
      expect(record).toThrow("Cannot trace io.runtime.js export createConfigIO");
      return;
    }
    expect(record().inventory.releases[0]?.chunks).toMatchObject([
      {
        path: "io.runtime.js",
        exports: ["createConfigIO", "readConfigFileSnapshot"].map((exported) => ({
          exported,
          origin: { module: "src/config/io.ts", symbol: exported },
        })),
      },
    ]);
  });

  it.each([
    ["2026.9.8", "io.runtime-BNEtkwm5.mjs"],
    ["2026.10.5-beta.1", "io.runtime-t3hrjkTX.mjs"],
  ])("traces the exact shipped %s config alias (%s)", (release, target) => {
    const alias = fsSync.readFileSync(
      path.join(MODULE_ROOT, `test/fixtures/update-config-runtime-alias-${release}.txt`),
      "utf8",
    );
    const exportedNames = [...alias.matchAll(/select\("(\w+)"\)/g)].flatMap(
      (match) => match[1] ?? [],
    );
    const sortedNames = exportedNames.toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const record = () =>
      recordImportedFixture('(await import("./io.runtime.js"))', {
        "io.runtime.js": alias,
        [target]: `export { ${exportedNames.join(", ")} } from "./config-abcdefgh.mjs";\n`,
        "config-abcdefgh.mjs": [
          "//#region src/config/io.ts",
          ...exportedNames.map((name) => `export function ${name}() {}`),
        ].join("\n"),
      });
    expect(record().inventory.releases[0]?.chunks).toMatchObject([
      {
        path: "io.runtime.js",
        exports: sortedNames.map((exported) => ({
          exported,
          origin: { module: "src/config/io.ts", symbol: exported },
        })),
      },
    ]);
  });

  it("records literal dist imports alongside computed package assets", () => {
    const { inventory } = recordImportedFixture(
      `await (async () => {
        await import(pathToFileURL(path.join(root, "node-runtime-recovery.mjs")).href);
        await import(pathToFileURL(path.join(root, "scripts", "stage-bundled-plugin-runtime.mts")).href);
        return (await import("./surface-abcdefgh.js")).x;
      })()`,
      { "surface-abcdefgh.js": "//#region src/infra/value.ts\nexport const x = 1;\n" },
    );
    expect(inventory.releases[0]?.chunks).toEqual([
      {
        path: "surface-abcdefgh.js",
        imports: [
          {
            importer: "command.js",
            owner: "src/cli/update-cli/update-command-service-command.ts",
            exports: ["x"],
          },
        ],
        exports: [{ exported: "x", origin: { module: "src/infra/value.ts", symbol: "x" } }],
      },
    ]);
  });

  it.each(
    previousReleaseInventory.releases
      .filter(({ version }) => ["2026.9.1", "2026.9.2", "2026.9.3", "2026.9.4"].includes(version))
      .flatMap((release, index) =>
        (index === 0
          ? ["exact", "version", "buildId", "commit", "integrity", "chunk", "owner", "symbol"]
          : ["exact"]
        ).map((changed) => ({ release, changed })),
      ),
  )(
    "corrects only verified coalesced release provenance ($release.version, $changed)",
    async ({ release, changed }) => {
      const chunk = release.chunks.find((entry) =>
        entry.exports.some((item) => item.exported === "markPluginRegistryRetired"),
      );
      if (!chunk) {
        throw new Error(`Missing historical retirement import for ${release.version}`);
      }
      const identity = { ...release };
      if (changed === "version") {
        identity.version = "2026.9.99";
      }
      if (changed === "buildId") {
        identity.buildId = "different-build";
      }
      if (changed === "commit") {
        identity.commit = "0".repeat(40);
      }
      if (changed === "integrity") {
        identity.integrity = integrity;
      }
      const target = changed === "chunk" ? "registry-lifecycle-unknown1.js" : chunk.path;
      const module =
        changed === "owner" ? "src/plugins/another-owner.ts" : "src/plugins/loader-cache-state.ts";
      const symbol = changed === "symbol" ? "anotherRetirement" : "markPluginRegistryRetired";
      const { inventory } = recordImportedFixture(
        `(await import("./${target}")).${symbol}`,
        { [target]: `//#region ${module}\nfunction ${symbol}() {}\nexport { ${symbol} };\n` },
        identity,
      );
      expect(inventory.releases[0]?.chunks[0]?.exports).toEqual([
        {
          exported: symbol,
          origin: {
            module: changed === "exact" ? "src/plugins/registry-lifecycle.ts" : module,
            symbol,
          },
        },
      ]);
      if (changed !== "exact") {
        return;
      }
      const current = createTempDir("update-compat-corrected-origin-");
      writeMany(current, {
        "package.json": '{"type":"module"}',
        "src/plugins/registry-lifecycle.ts":
          'export function markPluginRegistryRetired() { return "current"; }',
        "dist/current.mjs":
          '//#region src/plugins/registry-lifecycle.ts\nfunction markPluginRegistryRetired() { return "current"; }\nexport { markPluginRegistryRetired };\n',
      });
      writeUpdateCompatibilityChunks(bridgeOptions(current, inventory));
      const bridge = await import(pathToFileURL(path.join(current, "dist", target)).href);
      expect(bridge.markPluginRegistryRetired()).toBe("current");
    },
  );

  const imports = 'import("./left-abcdefgh.js"), import("./right-abcdefgh.js")';
  const all = `await Promise.all([${imports}])`;
  it.each([
    ["exact destructuring", `const [{ x: selected }, { y }] = ${all}`, true],
    ["namespace binding", `const [left, { y }] = ${all}`, false],
    ["object rest binding", `const [{ x, ...rest }, { y }] = ${all}`, false],
    ["array rest binding", `const [{ x }, ...rest] = ${all}`, false],
    ["default binding", `const [{ x = 0 }, { y }] = ${all}`, false],
    ["intermediate array", `const modules = ${all}; const [{ x }, { y }] = modules`, false],
    ["empty object binding", `const [{}, { y }] = ${all}`, false],
    ["nested binding", `const [{ x: { value } }, { y }] = ${all}`, false],
    ["omitted array binding", `const [, { y }] = ${all}`, false],
    ["optional call", `const [{ x }, { y }] = await Promise.all?.([${imports}])`, false],
    ["spread import array", `const [{ x }, { y }] = await Promise.all([...[], ${imports}])`, false],
    ["unawaited Promise.all", `const modules = Promise.all([${imports}])`, false],
    ["different combiner", `const [{ x }, { y }] = await Promise.race([${imports}])`, false],
    ["mixed array", `const [{ x }, { y }] = await Promise.all([${imports}, 1])`, false],
  ] as const)("records conservative module contracts for %s", (_access, statement, exact) => {
    const names = exact
      ? [["x"], ["y"]]
      : [
          ["x", "y"],
          ["x", "y"],
        ];
    const { inventory } = recordImportedFixture(`await (async () => { ${statement} })()`, {
      "left-abcdefgh.js": "//#region src/infra/left.ts\nexport const x = 1, y = 2;\n",
      "right-abcdefgh.js": "//#region src/infra/right.ts\nexport const x = 3, y = 4;\n",
    });
    expect(
      inventory.releases[0]?.chunks.map((chunk) => ({
        path: chunk.path,
        imported: chunk.imports.flatMap((entry) => entry.exports),
        exported: chunk.exports.map((entry) => entry.exported),
      })),
    ).toEqual([
      { path: "left-abcdefgh.js", imported: names[0], exported: names[0] },
      { path: "right-abcdefgh.js", imported: names[1], exported: names[1] },
    ]);
  });

  it.each([
    {
      access: "then",
      expression: 'import("./surface-abcdefgh.js").then((module) => module.x)',
      names: ["x", "y"],
    },
    {
      access: "awaited property",
      expression: '(await import("./surface-abcdefgh.js")).x',
      names: ["x"],
    },
    {
      access: "awaited bracket",
      expression: '(await import("./surface-abcdefgh.js"))["x"]',
      names: ["x"],
    },
  ])(
    "records namespace exports instead of Promise methods for $access access",
    ({ expression, names }) => {
      const { inventory } = recordImportedFixture(expression, {
        "surface-abcdefgh.js":
          "//#region src/infra/values.ts\nconst x = 1; const y = 2; export { x, y };\n",
      });
      expect(inventory.releases[0]?.chunks).toMatchObject([
        {
          path: "surface-abcdefgh.js",
          imports: [{ exports: names }],
          exports: names.map((exported) => ({
            exported,
            origin: { module: "src/infra/values.ts", symbol: exported },
          })),
        },
      ]);
    },
  );

  it.each(["distinct owners", "the same source annotation"])(
    "rejects conflicting emitted star bindings with %s and names both sources",
    (annotation) => {
      const leftOwner = annotation === "the same source annotation" ? "shared" : "left";
      const rightOwner = annotation === "the same source annotation" ? "shared" : "right";
      expect(() =>
        recordImportedFixture('(await import("./surface-abcdefgh.js")).x', {
          "surface-abcdefgh.js": 'export * from "./left.mjs"; export * from "./right.mjs";\n',
          "left.mjs": `//#region src/infra/${leftOwner}.ts\nexport const x = "left";\n`,
          "right.mjs": `//#region src/infra/${rightOwner}.ts\nexport const x = "right";\n`,
        }),
      ).toThrow(/(?=[\s\S]*left\.mjs)(?=[\s\S]*right\.mjs)/);
    },
  );

  it("resolves a star diamond to the single declaration shared by both paths", async () => {
    const { root, inventory } = recordImportedFixture('(await import("./surface-abcdefgh.js")).x', {
      "surface-abcdefgh.js": 'export * from "./left.mjs"; export * from "./right.mjs";\n',
      "left.mjs": 'export { x } from "./origin.mjs";\n',
      "right.mjs": 'export * from "./origin.mjs";\n',
      "origin.mjs": '//#region src/infra/origin.ts\nexport const x = { value: "shared" };\n',
    });
    const namespace = await import(pathToFileURL(path.join(root, "dist/surface-abcdefgh.js")).href);
    const declaration = await import(pathToFileURL(path.join(root, "dist/origin.mjs")).href);
    expect(namespace.x).toBe(declaration.x);
    expect(inventory.releases[0]?.chunks[0]?.exports).toEqual([
      { exported: "x", origin: { module: "src/infra/origin.ts", symbol: "x" } },
    ]);
  });

  it("lets an explicit export resolve an otherwise ambiguous star name", async () => {
    const { root, inventory } = recordImportedFixture('(await import("./surface-abcdefgh.js")).x', {
      "surface-abcdefgh.js":
        'export * from "./left.mjs"; export * from "./right.mjs"; export { x } from "./left.mjs";\n',
      "left.mjs": '//#region src/infra/left.ts\nexport const x = "left";\n',
      "right.mjs": '//#region src/infra/right.ts\nexport const x = "right";\n',
    });
    const namespace = await import(pathToFileURL(path.join(root, "dist/surface-abcdefgh.js")).href);
    expect(namespace.x).toBe("left");
    expect(inventory.releases[0]?.chunks[0]?.exports).toEqual([
      { exported: "x", origin: { module: "src/infra/left.ts", symbol: "x" } },
    ]);
  });

  it.each(["surface.js", "surface-abcdefgh.js"])(
    "rejects an existing %s whose star ambiguity omits the required export",
    (target) => {
      const { inventory } = recordImportedFixture(`(await import("./${target}")).x`, {
        [target]: '//#region src/infra/original.ts\nexport const x = "original";\n',
      });
      const root = createTempDir("update-compat-existing-stars-");
      writeMany(root, {
        "package.json": '{"type":"module"}\n',
        [`dist/${target}`]: 'export * from "./left.mjs"; export * from "./right.mjs";\n',
        "dist/left.mjs": '//#region src/infra/original.ts\nexport const x = "left";\n',
        "dist/right.mjs": '//#region src/infra/other.ts\nexport const x = "right";\n',
      });
      const namespaceHasX = childProcess.execFileSync(
        testNodeExecPath,
        [
          "--input-type=module",
          "-e",
          'const namespace = await import(process.argv[1]); console.log(Object.hasOwn(namespace, "x"));',
          pathToFileURL(path.join(root, "dist", target)).href,
        ],
        { encoding: "utf8" },
      );
      expect(namespaceHasX.trim()).toBe("false");
      expect(() => writeUpdateCompatibilityChunks(bridgeOptions(root, inventory))).toThrow(
        `${target} lacks x`,
      );
    },
  );

  it.each([
    {
      route: "source star forwarding",
      owner: 'export * from "./moved.js";\n',
      module: "src/infra/moved.ts",
      symbol: "oldName",
    },
    {
      route: "a local export alias",
      owner: 'function newName() { return "current"; } export { newName as oldName };\n',
      module: "src/infra/old.ts",
      symbol: "newName",
    },
  ])("bridges a moved declaration through $route", async ({ owner, module, symbol }) => {
    const { inventory } = recordImportedFixture('(await import("./surface-abcdefgh.js")).x', {
      "surface-abcdefgh.js":
        '//#region src/infra/old.ts\nfunction oldName() { return "old"; } export { oldName as x };\n',
    });
    const root = createTempDir("update-compat-source-forwarding-");
    writeMany(root, {
      "package.json": '{"type":"module"}\n',
      "src/infra/old.ts": owner,
    });
    if (module !== "src/infra/old.ts") {
      write(root, module, 'export function oldName() { return "current"; }\n');
    }
    write(
      root,
      "dist/current.mjs",
      `//#region ${module}\nfunction ${symbol}() { return "current"; } export { ${symbol} as n };\n`,
    );
    writeUpdateCompatibilityChunks(bridgeOptions(root, inventory));
    const bridge = await import(pathToFileURL(path.join(root, "dist/surface-abcdefgh.js")).href);
    expect(bridge.x()).toBe("current");
  });

  it("refuses ambiguous source stars and names both possible declaration owners", () => {
    const { inventory } = recordImportedFixture('(await import("./surface-abcdefgh.js")).x', {
      "surface-abcdefgh.js":
        '//#region src/infra/old.ts\nfunction oldName() { return "old"; } export { oldName as x };\n',
    });
    const root = createTempDir("update-compat-source-conflict-");
    write(root, "src/infra/old.ts", 'export * from "./left.js"; export * from "./right.js";\n');
    for (const side of ["left", "right"]) {
      writeMany(root, {
        [`src/infra/${side}.ts`]: `export function oldName() { return "${side}"; }\n`,
        [`dist/${side}.mjs`]: `//#region src/infra/${side}.ts\nfunction oldName() { return "${side}"; } export { oldName as n };\n`,
      });
    }
    expect(() => writeUpdateCompatibilityChunks(bridgeOptions(root, inventory))).toThrow(
      /(?=[\s\S]*left\.ts)(?=[\s\S]*right\.ts)/,
    );
    expect(fsSync.existsSync(path.join(root, "dist/surface-abcdefgh.js"))).toBe(false);
  });

  function writeWindowInventory(root: string): string {
    const release = recordFixture().releases[0];
    const output = path.join(root, "inventory.json");
    write(
      root,
      "inventory.json",
      JSON.stringify({
        schemaVersion: 1,
        releases: [
          release,
          { ...release, version: "2026.9.2", chunks: [] },
          { ...release, version: "2026.9.3", chunks: [] },
        ],
      }),
    );
    return output;
  }

  function serveTarball(archive: string): { child: childProcess.ChildProcess; url: string } {
    const root = createTempDir("update-compat-registry-");
    const portFile = path.join(root, "port");
    const server = path.join(root, "server.cjs");
    fsSync.writeFileSync(
      server,
      [
        'const fs = require("node:fs");',
        'const http = require("node:http");',
        "const [archive, portFile] = process.argv.slice(2);",
        "const instance = http.createServer((_request, response) => {",
        '  response.writeHead(200, { "content-type": "application/octet-stream" });',
        "  fs.createReadStream(archive).pipe(response);",
        "});",
        'instance.listen(0, "127.0.0.1", () => {',
        "  fs.writeFileSync(portFile, String(instance.address().port));",
        "});",
      ].join("\n"),
    );
    const child = childProcess.spawn(testNodeExecPath, [server, archive, portFile], {
      stdio: "ignore",
    });
    const deadline = Date.now() + 5_000;
    while (!fsSync.existsSync(portFile) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    if (!fsSync.existsSync(portFile)) {
      child.kill();
      throw new Error("fixture registry server did not start");
    }
    const port = fsSync.readFileSync(portFile, "utf8");
    return { child, url: `http://127.0.0.1:${port}/openclaw.tgz` };
  }

  function runInventoryCli(
    args: string[],
    replies: Array<{ args: string[]; value: unknown }> = [],
  ) {
    const root = createTempDir("update-compat-npm-");
    const bin = path.join(root, "bin");
    const callsFile = path.join(root, "calls.json");
    const stub = path.join(bin, "npm.cjs");
    writeMany(root, {
      "package.json": JSON.stringify({ openclaw: { schemaVersions: { state: 1, agent: 1 } } }),
      "bin/npm.cjs": [
        `#!${testNodeExecPath}`,
        'const fs = require("node:fs");',
        `const callsFile = ${JSON.stringify(callsFile)};`,
        `const replies = ${JSON.stringify(replies)};`,
        'const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, "utf8")) : [];',
        "const args = process.argv.slice(2);",
        "const reply = replies[calls.length];",
        "calls.push(args);",
        "fs.writeFileSync(callsFile, JSON.stringify(calls));",
        'if (!reply || JSON.stringify(reply.args) !== JSON.stringify(args)) throw new Error("unexpected npm call: " + JSON.stringify(args));',
        "console.log(JSON.stringify(reply.value));",
      ].join("\n"),
    });
    if (process.platform === "win32") {
      write(root, "bin/npm.cmd", `@"${testNodeExecPath}" "${stub}" %*\r\n`);
    } else {
      fsSync.copyFileSync(stub, path.join(bin, "npm"));
      fsSync.chmodSync(path.join(bin, "npm"), 0o755);
    }
    const result = childProcess.spawnSync(
      testNodeExecPath,
      [path.join(MODULE_ROOT, "scripts/update-compat-inventory.mts"), ...args],
      {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        timeout: 30_000,
      },
    );
    const calls: unknown = fsSync.existsSync(callsFile)
      ? JSON.parse(fsSync.readFileSync(callsFile, "utf8"))
      : [];
    return { result, calls };
  }

  it("records an ordered supported window, including releases without post-swap imports, offline", () => {
    const root = createTempDir("update-compat-window-");
    const output = path.join(root, "inventory.json");
    const args = ["--output", output];
    for (const version of ["2026.9.3", "2026.9.1", "2026.9.2"]) {
      const packageDir = path.join(root, version);
      writeMany(packageDir, {
        "package.json": JSON.stringify({
          name: "openclaw",
          version,
          openclaw: { schemaVersions: { state: 1, agent: 1 } },
        }),
        "dist/build-info.json": JSON.stringify({
          version,
          buildId: version,
          commit: "0".repeat(40),
        }),
        "dist/entry.js": "export {};\n",
      });
      args.push("--release", `${packageDir}=${integrity}`);
    }
    const generated = runInventoryCli(args);
    expect(generated.result.status, generated.result.stderr).toBe(0);
    expect(generated.calls).toEqual([]);
    expect(
      readUpdateCompatibilityInventory(output).releases.map(
        ({ version, chunks, schemaVersions }) => ({ version, chunks, schemaVersions }),
      ),
    ).toEqual([
      { version: "2026.9.1", chunks: [], schemaVersions: { state: 1, agent: 1 } },
      { version: "2026.9.2", chunks: [], schemaVersions: { state: 1, agent: 1 } },
      { version: "2026.9.3", chunks: [], schemaVersions: { state: 1, agent: 1 } },
    ]);
    const checked = runInventoryCli([...args, "--check"]);
    expect(checked.result.status, checked.result.stderr).toBe(0);
    expect(checked.calls).toEqual([]);
  });

  it("downloads, verifies, and records an exact registry release", async () => {
    const root = createTempDir("update-compat-registry-release-");
    const version = "2026.9.4";
    writeMany(root, {
      "package/package.json": JSON.stringify({
        name: "openclaw",
        version,
        openclaw: { schemaVersions: { state: 1, agent: 1 } },
      }),
      "package/dist/build-info.json": JSON.stringify({
        version,
        buildId: version,
        commit: "0".repeat(40),
      }),
      "package/dist/entry.js": "export {};\n",
    });
    const archive = path.join(root, "openclaw.tgz");
    await createTar({ cwd: root, file: archive, gzip: true }, ["package"]);
    const registryIntegrity = `sha512-${createHash("sha512").update(fsSync.readFileSync(archive)).digest("base64")}`;
    const fixture = serveTarball(archive);
    try {
      const output = path.join(root, "inventory.json");
      const integrityArgs = ["view", `openclaw@${version}`, "dist.integrity", "--json"];
      const tarballArgs = ["view", `openclaw@${version}`, "dist.tarball", "--json"];
      const { result, calls } = runInventoryCli(
        ["--registry-release", version, "--output", output],
        [
          { args: integrityArgs, value: registryIntegrity },
          { args: tarballArgs, value: fixture.url },
        ],
      );
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([integrityArgs, tarballArgs]);
      expect(readUpdateCompatibilityInventory(output).releases).toMatchObject([
        { version, integrity: registryIntegrity, chunks: [] },
      ]);
      const rejected = runInventoryCli(
        ["--registry-release", version, "--output", path.join(root, "rejected.json")],
        [
          { args: integrityArgs, value: `sha512-${Buffer.alloc(64, 1).toString("base64")}` },
          { args: tarballArgs, value: fixture.url },
        ],
      );
      expect(rejected.result.status).toBe(1);
      expect(rejected.result.stderr).toContain("Registry tarball integrity mismatch");
      expect(fsSync.existsSync(path.join(root, "rejected.json"))).toBe(false);
    } finally {
      fixture.child.kill();
    }
  });

  it.each(["npm 11", "npm 12"])(
    "checks %s latest and beta coverage without refetching recorded integrity",
    (npmVersion) => {
      const output = writeWindowInventory(createTempDir("update-compat-tag-coverage-"));
      const tags = { latest: "2026.9.3", beta: "2026.9.2" };
      const npmArgs = ["view", "openclaw", "dist-tags", "--json"];
      const { result, calls } = runInventoryCli(
        ["--check", "--output", output],
        [{ args: npmArgs, value: npmVersion === "npm 12" ? [tags] : tags }],
      );
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([npmArgs]);
    },
  );

  it.each([
    { latest: "2026.9.3", beta: "2026.9.4-beta.1", missing: "2026.9.4-beta.1" },
    { latest: "2026.9.4", beta: "2026.9.4", missing: "2026.9.4" },
    { latest: "2026.9.3", beta: "2026.9.3", extendedStable: "2026.9.33", missing: "2026.9.33" },
  ])(
    "prints a complete refresh command when $missing leaves the window",
    ({ latest, beta, extendedStable, missing }) => {
      const output = writeWindowInventory(createTempDir("update-compat-tag-refresh-"));
      const tags = {
        latest,
        beta,
        ...(extendedStable ? { "extended-stable": extendedStable } : {}),
      };
      const expectedCalls = [
        ["view", "openclaw", "dist-tags", "--json"],
        ["view", `openclaw@${missing}`, "openclaw.schemaVersions", "--json"],
      ];
      const { result, calls } = runInventoryCli(
        ["--check", "--output", output],
        [
          { args: expectedCalls[0]!, value: latest === beta ? [tags] : tags },
          {
            args: expectedCalls[1]!,
            value: latest === beta ? [{ state: 1, agent: 1 }] : { state: 1, agent: 1 },
          },
        ],
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pnpm update:compat:gen --output");
      expect(result.stderr).toContain(output);
      expect(result.stderr).toContain(
        ["2026.9.1", "2026.9.2", "2026.9.3", missing]
          .toSorted((left, right) => left.localeCompare(right, undefined, { numeric: true }))
          .map((version) => `--registry-release ${version}`)
          .join(" "),
      );
      expect(calls).toEqual(expectedCalls);
    },
  );

  it.each([
    { state: 2, agent: 1 },
    { state: 1, agent: 2 },
  ])("accounts for newer-schema npm tags without requiring a downgrade bridge: %j", (schemas) => {
    const output = writeWindowInventory(createTempDir("update-compat-newer-tag-"));
    const npmArgs = ["view", "openclaw", "dist-tags", "--json"];
    const schemaArgs = ["view", "openclaw@2026.10.1-beta.1", "openclaw.schemaVersions", "--json"];
    const { result, calls } = runInventoryCli(
      ["--check", "--output", output],
      [
        { args: npmArgs, value: { latest: "2026.9.3", beta: "2026.10.1-beta.1" } },
        { args: schemaArgs, value: [schemas] },
      ],
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Accounted unsupported first-hop source 2026.10.1-beta.1");
    expect(calls).toEqual([npmArgs, schemaArgs]);
  });

  it.each([
    { tags: { beta: "2026.9.3" }, invalid: "latest" },
    { tags: { latest: "2026.9.3", beta: "not-a-release" }, invalid: "beta" },
    {
      tags: { latest: "2026.9.3", beta: "2026.9.3", "extended-stable": "not-a-release" },
      invalid: "extended-stable",
    },
  ])("refuses an absent or invalid $invalid dist-tag", ({ tags, invalid }) => {
    const output = writeWindowInventory(createTempDir("update-compat-invalid-tags-"));
    const npmArgs = ["view", "openclaw", "dist-tags", "--json"];
    const { result, calls } = runInventoryCli(
      ["--check", "--output", output],
      [{ args: npmArgs, value: tags }],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`dist-tag ${invalid} is missing or invalid`);
    expect(calls).toEqual([npmArgs]);
  });

  it("refuses conflicting release origins before writing any bridge", () => {
    const inventory = recordFixture();
    const newer = structuredClone(inventory.releases[0]);
    newer.version = "2026.9.2";
    const firstExport = newer.chunks[0]?.exports[0];
    if (!firstExport) {
      throw new Error("Fixture has no recorded export");
    }
    firstExport.origin.module = "src/cli/update-cli/different.ts";
    inventory.releases.push(newer);
    const conflict =
      /Release inventories disagree about service-abcdefgh.js:mode: 2026.9.1 uses .*; 2026.9.2 uses/;
    expect(() => parseUpdateCompatibilityInventory(inventory)).toThrow(conflict);
    const root = createTempDir("update-compat-conflict-");
    candidate(root);
    expect(() => writeUpdateCompatibilityChunks(bridgeOptions(root, inventory))).toThrow(conflict);
    expect(fsSync.existsSync(path.join(root, "dist/service-abcdefgh.js"))).toBe(false);
  });

  it("keeps compatibility facades out of current runtime alias selection on rebuild", async () => {
    const inventory = recordFixture();
    inventory.releases[0].chunks = inventory.releases[0].chunks.map((chunk) => ({
      ...chunk,
      path: "worker.runtime-12345678.js",
    }));
    const root = createTempDir("update-compat-rebuild-");
    candidate(root);
    fsSync.renameSync(
      path.join(root, "dist/current.mjs"),
      path.join(root, "dist/worker.runtime-abcdefgh.mjs"),
    );
    writeStableRootRuntimeAliases({ rootDir: root });
    writeUpdateCompatibilityChunks(bridgeOptions(root, inventory));
    writeStableRootRuntimeAliases({ rootDir: root });
    const current = await import(pathToFileURL(path.join(root, "dist/worker.runtime.js")).href);
    expect(current.x()).toBe("node");
    expect(current.y()).toBe("npm");
  });

  it("retains only terminal cleanup-scope imports after package replacement", () => {
    const target = "runtime-cleanup-abcdefgh.mjs";
    const { root, inventory } = recordImportedFixture(
      `(async () => {
        const { prepare } = await import("./prepare-abcdefgh.mjs");
        prepare();
        try { return; } finally {
          return (await import("./${target}")).runCliDisposerAfterPending();
        }
      })()`,
      {
        "prepare-abcdefgh.mjs":
          "//#region src/infra/gateway-scheduler.ts\nexport function prepare() {}\n",
        [target]:
          '//#region src/cli/runtime-cleanup.ts\nexport function runCliDisposerAfterPending() { return "old"; }\n',
      },
      undefined,
      "src/cli/runtime-cleanup-scope.ts",
    );
    expect(inventory.releases[0]?.chunks.map((chunk) => chunk.path)).toEqual([target]);
    fsSync.unlinkSync(path.join(root, "dist", target));
    write(
      root,
      "dist/current.mjs",
      '//#region src/cli/runtime-cleanup.ts\nfunction runCliDisposerAfterPending() { return "current"; } export { runCliDisposerAfterPending as cleanup };\n',
    );
    writeUpdateCompatibilityChunks(bridgeOptions(root, inventory));
    const result = childProcess.execFileSync(
      testNodeExecPath,
      [
        "--input-type=module",
        "-e",
        'import { unlinkSync } from "node:fs"; import { fileURLToPath } from "node:url"; const scope = await import(process.argv[1]); unlinkSync(fileURLToPath(process.argv[1])); console.log(await scope.restart());',
        pathToFileURL(path.join(root, "dist/command.js")).href,
      ],
      { encoding: "utf8" },
    );
    expect(result.trim()).toBe("current");
  });

  it.each([
    'import { y as mode } from "../current.mjs"; export { mode as forwarded };',
    'export { y as forwarded } from "../current.mjs";',
    'export * from "../current.mjs";',
  ])("bridges shared declaration bindings through %s", async (forwarding) => {
    const inventory = recordFixture(true);
    expect(inventory.releases[0].chunks).toHaveLength(1);
    const root = createTempDir("update-compat-shared-binding-");
    candidate(root);
    fsSync.appendFileSync(path.join(root, "dist/current.mjs"), "\nexport { resolveMode as z };\n");
    write(
      root,
      "dist/a-facade/forward.mjs",
      `//#region src/cli/update-cli/mode.ts\n${forwarding}\n`,
    );
    const options = { distDir: path.join(root, "dist"), sourceDir: root, inventory };
    writeUpdateCompatibilityChunks(options);
    const bridge = path.join(root, "dist/service-abcdefgh.js");
    const contents = fsSync.readFileSync(bridge, "utf8");
    expect(contents).toContain('export { y as mode } from "./current.mjs";');
    writeUpdateCompatibilityChunks(options);
    expect(fsSync.readFileSync(bridge, "utf8")).toBe(contents);
    const loaded = await import(pathToFileURL(bridge).href);
    const current = await import(pathToFileURL(path.join(root, "dist/current.mjs")).href);
    expect(loaded.mode).toBe(current.y);
    expect(loaded.mode()).toBe("npm");
    expect(loaded.runner).toBe(current.x);
  });

  it.each([
    "config-doctor",
    "native-hook-relay",
    "control-ui",
    "control-ui.build-123-fixture",
    "control-ui.build-123-fixture.retired",
  ])("never borrows a missing runtime binding from %s", (directory) => {
    const inventory = recordFixture();
    const root = createTempDir("update-compat-isolated-graph-");
    candidate(root);
    const current = path.join(root, "dist/current.mjs");
    write(root, `dist/${directory}/inspect.mjs`, fsSync.readFileSync(current, "utf8"));
    fsSync.unlinkSync(current);
    expect(() => writeUpdateCompatibilityChunks(bridgeOptions(root, inventory))).toThrow(
      /no equivalent current export/,
    );
    expect(fsSync.existsSync(path.join(root, "dist/service-abcdefgh.js"))).toBe(false);
  });

  it.each(["missing", "ambiguous"])(
    "refuses %s required implementations before writing bridges",
    (failure) => {
      const inventory = recordFixture();
      const root = createTempDir("update-compat-refusal-");
      candidate(root);
      if (failure === "missing") {
        write(root, "dist/current.mjs", "export {};\n");
      } else {
        fsSync.copyFileSync(
          path.join(root, "dist/current.mjs"),
          path.join(root, "dist/duplicate.mjs"),
        );
      }
      expect(() => writeUpdateCompatibilityChunks(bridgeOptions(root, inventory))).toThrow(
        /Cannot bridge service-abcdefgh\.js export mode/,
      );
      expect(fsSync.existsSync(path.join(root, "dist/service-abcdefgh.js"))).toBe(false);
    },
  );

  it("does not replace a public entrypoint to conceal a missing export", () => {
    const inventory = recordFixture();
    inventory.releases[0].chunks = inventory.releases[0].chunks.map((chunk) => ({
      ...chunk,
      path: "service.js",
    }));
    const root = createTempDir("update-compat-public-");
    candidate(root);
    const original = "export const other = true;\n";
    write(root, "dist/service.js", original);
    expect(() => writeUpdateCompatibilityChunks(bridgeOptions(root, inventory))).toThrow(
      /service\.js lacks mode/,
    );
    expect(fsSync.readFileSync(path.join(root, "dist/service.js"), "utf8")).toBe(original);
  });
});
