import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type InlineConfig, type UserConfig } from "tsdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExternalPluginLocalDist } from "../../scripts/build-external-plugin-local-dist.mts";
import { rewriteStandaloneImports } from "../../scripts/lib/bun-standalone-imports.mjs";
import { createStandaloneSourceEntries } from "../../scripts/lib/bun-standalone-source-entries.mjs";
import { createStandaloneSourceGraph } from "../../scripts/lib/bun-standalone-source-graph.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";
import { createStandaloneSourceTransforms } from "../../scripts/lib/bun-standalone-source-transforms.mjs";
import { createPluginInventoryModuleRefsPlugin } from "../../scripts/lib/plugin-inventory-module-refs.mts";
import {
  createPluginNpmRuntimeBuildOptions,
  resolvePluginNpmRuntimeBuildPlan,
} from "../../scripts/lib/plugin-npm-runtime-build.mts";
import {
  createStandaloneSourceModuleUrlPlugin,
  readStandaloneSourceModuleIdentities,
  updateStandaloneSourceModuleUrlChunks,
} from "../../scripts/lib/standalone-source-module-urls.mjs";
import { copyStaticExtensionAssets } from "../../scripts/lib/static-extension-assets.mts";
import { openRootFileSync } from "../../src/infra/boundary-file-read.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const roots: string[] = [];
const formats: Array<"esm" | "cjs"> = ["esm", "cjs"];
const helperContents = `import fs from "node:fs";
export function readBuildInfo(): string {
  return fs.readFileSync(new URL("./build-info.json", import.meta.url), "utf8");
}
`;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-module-urls-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const write = (relative: string, contents: string) => {
    const filename = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    return filename;
  };
  write("package.json", '{"name":"openclaw","type":"module"}\n');
  const helper = write("src/identity.ts", helperContents);
  write("src/main.ts", 'export { readBuildInfo } from "./identity.ts";\n');
  write("src/other.ts", 'export { readBuildInfo } from "./identity.ts";\n');
  return { root, sourceRoot, helper, write };
}

async function buildOwner(sourceRoot: string, format: "esm" | "cjs", outDir = "dist") {
  const extension = format === "cjs" ? ".cjs" : ".mjs";
  const entry = { main: "src/main.ts", other: "src/other.ts" };
  const config = {
    config: false,
    cwd: sourceRoot,
    entry,
    outDir,
    format,
    platform: "node",
    dts: false,
    clean: false,
    minify: true,
    sourcemap: false,
    logLevel: "silent",
    outExtensions: () => ({ js: extension }),
    plugins: [createStandaloneSourceModuleUrlPlugin({ rootDir: sourceRoot })],
  } satisfies InlineConfig;
  const built = await build(config);
  expect(
    built.bundles
      .flatMap((bundle) => bundle.chunks)
      .some((chunk) => chunk.fileName.startsWith(".source-module-urls/")),
  ).toBe(true);
  return config;
}

function runRelocatedHelper(
  root: string,
  sourceRoot: string,
  runtimeOutput: string,
  sourceOptions?: {
    filename: string;
    physicalFilename: string;
    resolveModuleUrl: () => string | undefined;
  },
) {
  const stageRoot = path.join(root, "stage");
  const runtimeRoot = path.join(root, "relocated", "runtime");
  const staged =
    sourceOptions?.filename ??
    path.join(stageRoot, ".typed-source", "context", "src", "identity.ts");
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, helperContents);
  const rewritten = rewriteStandaloneImports({
    contents: fs.readFileSync(staged, "utf8"),
    filename: staged,
    physicalFilename: sourceOptions?.physicalFilename,
    resolveModuleUrl:
      sourceOptions?.resolveModuleUrl ?? (() => path.join(stageRoot, runtimeOutput)),
    runtimeRoot: stageRoot,
    embeddedPaths: {},
    moduleAliases: {},
    workerThreadsShim: path.join(stageRoot, "worker-threads.cjs"),
    parse: createStandaloneSourceParser(),
    preserveTypes: true,
  });
  expect(rewritten).toContain(JSON.stringify(runtimeOutput));
  const buildInfo = path.join(runtimeRoot, path.dirname(runtimeOutput), "build-info.json");
  fs.mkdirSync(path.dirname(buildInfo), { recursive: true });
  fs.writeFileSync(buildInfo, JSON.stringify({ commit: "source-owner-commit" }));
  const executableHelper = path.join(runtimeRoot, "typed-helper.mjs");
  fs.writeFileSync(executableHelper, stripTypeScriptTypes(rewritten));
  fs.rmSync(sourceRoot, { recursive: true });
  fs.rmSync(stageRoot, { recursive: true });
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `globalThis.__openclawStandaloneRootUrl = ${JSON.stringify(pathToFileURL(`${runtimeRoot}${path.sep}`).href)};
const helper = await import(${JSON.stringify(pathToFileURL(executableHelper).href)});
process.stdout.write(helper.readBuildInfo());`,
    ],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
  );
  expect(JSON.parse(output)).toEqual({ commit: "source-owner-commit" });
  expect(fs.existsSync(sourceRoot)).toBe(false);
  expect(fs.existsSync(stageRoot)).toBe(false);
}

describe("standalone source module URL ownership", () => {
  it("distinguishes unrendered loaded sources from external and unknown files per build", async () => {
    const { sourceRoot, write } = fixture();
    write("tsconfig.json", '{"compilerOptions":{"verbatimModuleSyntax":true}}');
    const discarded = write("src/discarded.ts", helperContents);
    const facade = write("src/facade.ts", 'export { retained } from "./retained.ts";');
    write("src/retained.ts", "export const retained = 7;");
    const external = write("src/external.ts", "export const external = 9;");
    const unknown = write("src/unknown.ts", helperContents);
    write(
      "src/main.ts",
      'import { readBuildInfo } from "./discarded.ts"; export { retained } from "./facade.ts"; export { external } from "./external.ts";',
    );
    const config = {
      config: false,
      cwd: sourceRoot,
      entry: { main: "src/main.ts" },
      outDir: "dist",
      platform: "node",
      format: "esm",
      dts: false,
      logLevel: "silent",
      inputOptions: { external: [external] },
      plugins: [createStandaloneSourceModuleUrlPlugin({ rootDir: sourceRoot })],
    } satisfies InlineConfig;
    await build(config);
    const { rendered: urls } = readStandaloneSourceModuleIdentities({
      sourceRoot,
      outputRoot: path.join(sourceRoot, "dist"),
      entries: [{ source: "src/main.ts", output: "dist/main.mjs" }],
    });
    expect(urls.get(discarded)).toEqual([]);
    expect(urls.get(facade)).toEqual([]);
    expect(urls.has(external)).toBe(false);
    expect(urls.has(unknown)).toBe(false);
    const entries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    expect(entries.isUnrenderedSource(discarded, config)).toBe(true);
    expect(entries.isUnrenderedSource(unknown, config)).toBe(false);
    expect(() => entries.resolveModuleUrl(discarded, config)).toThrow("found 0");
    for (const source of [discarded, external, unknown]) {
      expect(() => entries.resolveEmittedModuleUrl(source, config)).toThrow("found 0");
    }
    const retainedConfig = {
      ...config,
      entry: { main: "src/discarded.ts" },
      outDir: "retained",
    };
    await build(retainedConfig);
    expect(
      createStandaloneSourceEntries({ sourceRoot, configs: [retainedConfig] }).isUnrenderedSource(
        discarded,
        retainedConfig,
      ),
    ).toBe(false);
    expect(
      createStandaloneSourceEntries({ sourceRoot, configs: [retainedConfig] }).resolveModuleUrl(
        discarded,
        retainedConfig,
      ),
    ).toBe("retained/main.mjs");
    expect(urls.get(discarded)).toEqual([]);
  });

  it.each(formats)(
    "relocates a transitive original TS metadata read from minified %s output",
    async (format) => {
      const { root, sourceRoot, helper } = fixture();
      const config = await buildOwner(sourceRoot, format);
      const entries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
      const output = entries.resolveModuleUrl(helper, config);
      expect(output).not.toMatch(/\/(?:main|other)\.[cm]js$/);
      expect(path.extname(output)).toBe(format === "cjs" ? ".cjs" : ".mjs");
      expect(fs.readFileSync(path.join(sourceRoot, output), "utf8")).not.toContain("//#region");
      runRelocatedHelper(root, sourceRoot, output);
    },
  );

  it("uses the rendered body for a named-root facade after actual postbuild alias rewrites", async () => {
    const { root, sourceRoot, write } = fixture();
    const helper = write("src/identity.runtime.ts", helperContents);
    write("src/main.ts", 'export { readBuildInfo } from "./identity.runtime.ts";\n');
    write("src/other.ts", 'export { readBuildInfo } from "./identity.runtime.ts";\n');
    const entry = {
      main: "src/main.ts",
      other: "src/other.ts",
      "identity.runtime": "src/identity.runtime.ts",
      "identity-alias.runtime": "src/identity.runtime.ts",
    };
    const config = {
      config: false,
      cwd: sourceRoot,
      entry,
      outDir: "dist",
      format: "esm",
      platform: "node",
      dts: false,
      minify: true,
      sourcemap: false,
      logLevel: "silent",
      outExtensions: () => ({ js: ".js" }),
      inputOptions: { preserveEntrySignatures: "strict" },
      outputOptions: {
        codeSplitting: { groups: [{ name: "shared.runtime", test: /identity\.runtime\.ts$/ }] },
      },
      plugins: [createStandaloneSourceModuleUrlPlugin({ rootDir: sourceRoot })],
    } satisfies InlineConfig;
    await build(config);
    const postbuildOwner = pathToFileURL(path.resolve("scripts/runtime-postbuild.mts")).href;
    execFileSync(
      "node",
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--input-type=module",
        "--eval",
        `import { writeStableRootRuntimeAliases, rewriteRootRuntimeImportsToStableAliases } from ${JSON.stringify(postbuildOwner)};
const rootDir = process.argv[1];
writeStableRootRuntimeAliases({ rootDir });
rewriteRootRuntimeImportsToStableAliases({ rootDir });`,
        sourceRoot,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    const entries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const runtimeOutput = entries.resolveModuleUrl(helper, config);
    const facadeOutput = ["dist/identity.runtime.js", "dist/identity-alias.runtime.js"].find(
      (output) => output !== runtimeOutput,
    );
    if (!facadeOutput) {
      throw new Error("Missing distinct named facade");
    }
    expect(fs.readFileSync(path.join(sourceRoot, facadeOutput), "utf8")).not.toContain(
      "readFileSync",
    );
    const runtimeRoot = path.join(root, "stage");
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const graph = createStandaloneSourceGraph({
      sourceRoot,
      runtimeRoot,
      outputRoot: root,
      sourceEntries: entries,
      embeddedPaths: {},
    });
    const transforms = createStandaloneSourceTransforms({
      sourceRoot,
      runtimeRoot,
      parse: createStandaloneSourceParser(),
    });
    expect(
      (await transforms.transform({ filename: helper, contents: helperContents, config })).contents,
    ).toBe(helperContents);
    const filename = graph.addEntry(facadeOutput);
    if (!filename) {
      throw new Error("Missing named source root");
    }
    expect(graph.files.get(filename)?.runtimePath).toBe(facadeOutput);
    const resolvedModuleUrl = graph.resolveModuleUrl(filename);
    if (!resolvedModuleUrl) {
      throw new Error("Missing named source module URL");
    }
    expect(resolvedModuleUrl).toBe(path.join(runtimeRoot, runtimeOutput));
    runRelocatedHelper(root, sourceRoot, runtimeOutput, {
      filename,
      physicalFilename: path.join(runtimeRoot, facadeOutput),
      resolveModuleUrl: () => resolvedModuleUrl,
    });
  });

  it("rejects changed output until its postbuild owner verifies and updates the hash", async () => {
    const { sourceRoot, helper } = fixture();
    const config = await buildOwner(sourceRoot, "esm");
    const index = () => createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const output = index().resolveModuleUrl(helper, config);
    const filename = path.join(sourceRoot, output);
    const original = fs.readFileSync(filename, "utf8");
    const rewritten = `${original}\n// postbuild import rewrite\n`;
    fs.writeFileSync(filename, rewritten);
    expect(() => index().resolveModuleUrl(helper, config)).toThrow("chunk hash mismatch");
    expect(() =>
      updateStandaloneSourceModuleUrlChunks({
        outputRoot: path.join(sourceRoot, "dist"),
        rewrites: [{ filename, original: "wrong old bytes", rewritten }],
      }),
    ).toThrow("original hash mismatch");
    expect(
      updateStandaloneSourceModuleUrlChunks({
        outputRoot: path.join(sourceRoot, "dist"),
        rewrites: [{ filename, original, rewritten }],
      }),
    ).toBe(1);
    expect(index().resolveModuleUrl(helper, config)).toBe(output);
  });

  it("refreshes metadata when declared static JavaScript replaces a bundled entry", async () => {
    const { root, sourceRoot, write } = fixture();
    const assetContents = helperContents.replace(": string", "");
    const helper = write("extensions/plugin/identity.js", assetContents);
    write("src/main.ts", 'export { readBuildInfo } from "../extensions/plugin/identity.js";\n');
    write("src/other.ts", 'export { readBuildInfo } from "../extensions/plugin/identity.js";\n');
    write(
      "extensions/plugin/package.json",
      JSON.stringify({
        name: "@openclaw/plugin",
        type: "module",
        openclaw: { build: { staticAssets: [{ source: "./identity.js", output: "identity.js" }] } },
      }),
    );
    const config = {
      config: false,
      cwd: sourceRoot,
      entry: {
        main: "src/main.ts",
        other: "src/other.ts",
        "extensions/plugin/identity": helper,
      },
      outDir: "dist",
      format: "esm",
      platform: "node",
      dts: false,
      minify: true,
      sourcemap: false,
      logLevel: "silent",
      outExtensions: () => ({ js: ".js" }),
      plugins: [createStandaloneSourceModuleUrlPlugin({ rootDir: sourceRoot })],
    } satisfies InlineConfig;
    await build(config);
    const index = () => createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const output = index().resolveModuleUrl(helper, config);
    const assetOutput = "dist/extensions/plugin/identity.js";
    expect(fs.readFileSync(path.join(sourceRoot, assetOutput), "utf8")).not.toBe(assetContents);
    copyStaticExtensionAssets({ rootDir: sourceRoot });
    expect(fs.readFileSync(path.join(sourceRoot, assetOutput), "utf8")).toBe(assetContents);
    expect(index().resolveModuleUrl(helper, config)).toBe(output);
    runRelocatedHelper(root, sourceRoot, output);
  });

  it("updates multiple chunks with one read and write per metadata ledger", async () => {
    const { sourceRoot, helper } = fixture();
    const config = await buildOwner(sourceRoot, "esm");
    const metadataDirectory = path.join(sourceRoot, "dist/.source-module-urls");
    const [metadataName] = fs.readdirSync(metadataDirectory);
    if (!metadataName) {
      throw new Error("Missing module URL metadata");
    }
    const metadataPath = path.join(metadataDirectory, metadataName);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const rewrites = metadata.chunks.map((chunk: { output: string }) => {
      const filename = path.join(sourceRoot, "dist", chunk.output);
      const original = fs.readFileSync(filename, "utf8");
      const rewritten = `${original}\n// batched postbuild rewrite\n`;
      fs.writeFileSync(filename, rewritten);
      return { filename, original, rewritten };
    });
    expect(rewrites.length).toBeGreaterThan(1);
    const reads = vi.spyOn(fs, "readFileSync");
    const writes = vi.spyOn(fs, "writeFileSync");
    expect(
      updateStandaloneSourceModuleUrlChunks({
        outputRoot: path.join(sourceRoot, "dist"),
        rewrites,
      }),
    ).toBe(1);
    expect(reads.mock.calls.filter(([filename]) => filename === metadataPath)).toHaveLength(1);
    expect(writes.mock.calls.filter(([filename]) => filename === metadataPath)).toHaveLength(1);
    expect(
      createStandaloneSourceEntries({ sourceRoot, configs: [config] }).resolveModuleUrl(
        helper,
        config,
      ),
    ).toMatch(/^dist\//);
  });

  it("binds a pnpm dependency entry to its emitted physical module", async () => {
    const { sourceRoot } = fixture();
    const dependencyLink = path.join(sourceRoot, "node_modules/highlight.js");
    fs.mkdirSync(path.dirname(dependencyLink), { recursive: true });
    fs.symlinkSync(
      path.resolve("node_modules/highlight.js"),
      dependencyLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    const declaredSource = path.join(dependencyLink, "lib/index.js");
    const physicalSource = fs.realpathSync(declaredSource);
    expect(physicalSource).not.toBe(declaredSource);
    expect(physicalSource.split(path.sep)).toContain(".pnpm");
    const config = {
      config: false,
      cwd: sourceRoot,
      entry: { main: "src/main.ts", highlight: "node_modules/highlight.js/lib/index.js" },
      outDir: "dist",
      format: "esm",
      platform: "node",
      dts: false,
      logLevel: "silent",
      outExtensions: () => ({ js: ".mjs" }),
      plugins: [createStandaloneSourceModuleUrlPlugin({ rootDir: sourceRoot })],
    } satisfies InlineConfig;
    await build(config);
    const entries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    expect(entries.resolveModuleUrl(physicalSource, config)).toBe("dist/highlight.mjs");
  });

  it("keeps checkout-relative source ownership when a build uses a nested cwd", async () => {
    const { root, sourceRoot, write } = fixture();
    const source = write("packages/leaf/nested/index.ts", helperContents);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const plugin = createStandaloneSourceModuleUrlPlugin({ rootDir: sourceRoot });
    cwd.mockRestore();
    const config = {
      config: false,
      cwd: path.dirname(source),
      entry: { main: "index.ts" },
      outDir: "dist",
      format: "esm",
      platform: "node",
      dts: false,
      minify: true,
      sourcemap: false,
      logLevel: "silent",
      outExtensions: () => ({ js: ".mjs" }),
      plugins: [plugin],
    } satisfies InlineConfig;
    await build(config);
    const entries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    const output = entries.resolveModuleUrl(source, config);
    expect(output).toBe("packages/leaf/nested/dist/main.mjs");
    runRelocatedHelper(root, sourceRoot, output);
  });

  it("requires fresh producer metadata instead of inferring an emitted location", async () => {
    const { sourceRoot, helper } = fixture();
    const config = await buildOwner(sourceRoot, "esm");
    const directory = path.join(sourceRoot, "dist/.source-module-urls");
    const [metadataName] = fs.readdirSync(directory);
    if (!metadataName) {
      throw new Error("Missing module URL metadata");
    }
    const filename = path.join(directory, metadataName);
    const metadata = JSON.parse(fs.readFileSync(filename, "utf8"));
    fs.writeFileSync(filename, JSON.stringify({ ...metadata, version: 2 }));
    expect(() =>
      createStandaloneSourceEntries({ sourceRoot, configs: [config] }).resolveModuleUrl(
        helper,
        config,
      ),
    ).toThrow("Run pnpm build");
    delete metadata.chunks[0].facadeSource;
    fs.writeFileSync(filename, JSON.stringify(metadata));
    expect(() =>
      createStandaloneSourceEntries({ sourceRoot, configs: [config] }).resolveModuleUrl(
        helper,
        config,
      ),
    ).toThrow("Run pnpm build");
    fs.rmSync(directory, { recursive: true });
    const entries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    expect(() => entries.resolveModuleUrl(helper, config)).toThrow("Run pnpm build");
  });

  it("keeps the same source's emitted URL separate for each real build configuration", async () => {
    const { sourceRoot, helper } = fixture();
    const main = await buildOwner(sourceRoot, "esm", "dist/main");
    const worker = await buildOwner(sourceRoot, "esm", "dist/worker");
    const entries = createStandaloneSourceEntries({ sourceRoot, configs: [main, worker] });
    const mainOutput = entries.resolveModuleUrl(helper, main);
    const workerOutput = entries.resolveModuleUrl(helper, worker);
    expect(mainOutput).toMatch(/^dist\/main\//);
    expect(workerOutput).toMatch(/^dist\/worker\//);
    expect(mainOutput).not.toBe(workerOutput);
  });

  it("rejects two recorded bodies inside one configuration", async () => {
    const { root, sourceRoot, helper } = fixture();
    const config = await buildOwner(sourceRoot, "esm");
    const output = createStandaloneSourceEntries({
      sourceRoot,
      configs: [config],
    }).resolveModuleUrl(helper, config);
    const metadataDirectory = path.join(sourceRoot, "dist/.source-module-urls");
    const [metadataName] = fs.readdirSync(metadataDirectory);
    if (!metadataName) {
      throw new Error("Missing module URL metadata");
    }
    const metadataPath = path.join(metadataDirectory, metadataName);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const body = metadata.chunks.find(
      (chunk: { output: string }) => chunk.output === path.relative("dist", output),
    );
    const duplicate = "duplicate-body.mjs";
    fs.copyFileSync(path.join(sourceRoot, output), path.join(sourceRoot, "dist", duplicate));
    metadata.chunks.push({ ...body, output: duplicate });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const entries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
    expect(() => entries.resolveModuleUrl(helper, config)).toThrow("found 2");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
    const graph = createStandaloneSourceGraph({
      sourceRoot,
      runtimeRoot,
      outputRoot: root,
      sourceEntries: entries,
      embeddedPaths: {},
    });
    expect(() => graph.addEmittedChunk({ id: helper, config })).toThrow("found 2");
  });

  it("keeps inventory-emitted companions out of the declared entry contract", async () => {
    const { root, sourceRoot, write } = fixture();
    const packageDir = path.join(sourceRoot, "extensions/plugin");
    writeJsonFile(path.join(packageDir, "package.json"), {
      name: "@openclaw/plugin",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.ts"], setupEntry: "./setup-entry.ts" },
    });
    write(
      "extensions/plugin/index.ts",
      'export { readBuildInfo } from "./channel-plugin-api.ts";\n',
    );
    write(
      "extensions/plugin/setup-entry.ts",
      `import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";
export default defineBundledChannelSetupEntry({ plugin: { specifier: "./channel-plugin-api.ts", exportName: "readBuildInfo" } });
`,
    );
    const helper = write("extensions/plugin/channel-plugin-api.ts", helperContents);
    const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot: sourceRoot, packageDir });
    assert(plan, "Missing inventory fixture plan");
    const named = new Set<string>();
    const [base] = createPluginNpmRuntimeBuildOptions(plan, { logLevel: "silent" });
    assert(base, "Missing inventory fixture build config");
    const config = {
      ...base,
      cwd: sourceRoot,
      outputOptions: {
        ...base.outputOptions,
        entryFileNames(chunk) {
          if (named.has(chunk.name)) {
            throw new Error(`Entry naming repeated for ${chunk.name}`);
          }
          named.add(chunk.name);
          return `${chunk.name}.js`;
        },
      },
    } satisfies UserConfig;
    await build(config);
    const { rendered: urls } = readStandaloneSourceModuleIdentities({
      sourceRoot,
      outputRoot: plan.outDir,
      entries: Object.entries(plan.entry).map(([name, source]) => ({
        source,
        output: path.join(plan.outDir, `${name}.js`),
      })),
    });
    const outputs = urls.get(helper);
    expect(outputs).toHaveLength(1);
    const output = outputs?.[0];
    assert(output, "Missing inventory companion output");
    runRelocatedHelper(root, sourceRoot, output);
  });

  it.each([
    { declared: false, reexport: false },
    { declared: true, reexport: false },
    { declared: false, reexport: true },
    { declared: true, reexport: true },
  ])(
    "keeps a lazy companion inside its plugin boundary and embedded graph ($declared / $reexport)",
    async ({ declared, reexport }) => {
      const { root, sourceRoot, write } = fixture();
      const pluginRoot = "dist/extensions/demo";
      const setupName = "extensions/demo/setup-entry";
      const companionName = "extensions/demo/legacy-session-surface-api";
      const companion = write(
        "extensions/demo/legacy-session-surface-api.ts",
        reexport ? 'export { marker } from "./leaf.js";\n' : "export const marker: number = 73;\n",
      );
      const leaf = reexport
        ? write("extensions/demo/leaf.js", "export const marker = 73;\n")
        : undefined;
      const source = `import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";
export default defineBundledChannelSetupEntry({ legacySessionSurface: { specifier: "./legacy-session-surface-api.js" } });`;
      const setup = write("extensions/demo/setup-entry.ts", source);
      const entry = { [setupName]: setup, ...(declared ? { [companionName]: companion } : {}) };
      const config = {
        config: false,
        cwd: sourceRoot,
        entry,
        outDir: "dist",
        format: "esm",
        platform: "node",
        dts: false,
        logLevel: "silent",
        outExtensions: () => ({ js: ".js" }),
        outputOptions: {
          entryFileNames: (chunk) =>
            Object.hasOwn(entry, chunk.name)
              ? "[name].js"
              : "extensions/demo/.setup/[name]-[hash].mjs",
          chunkFileNames: "extensions/demo/.setup/[name]-[hash].mjs",
        },
        plugins: [
          createPluginInventoryModuleRefsPlugin(path.join(sourceRoot, "extensions/demo")),
          createStandaloneSourceModuleUrlPlugin({ rootDir: sourceRoot }),
        ],
      } satisfies InlineConfig;
      await build(config);
      const runtimeRoot = path.join(root, "output/runtime");
      fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
      const sourceEntries = createStandaloneSourceEntries({ sourceRoot, configs: [config] });
      expect(sourceEntries.isUnrenderedSource(companion, config)).toBe(reexport);
      if (reexport) {
        expect(() => sourceEntries.resolveModuleUrl(companion, config)).toThrow("found 0");
      }
      const embeddedPaths: Record<string, string> = {};
      const graph = createStandaloneSourceGraph({
        sourceRoot,
        runtimeRoot,
        outputRoot: path.dirname(runtimeRoot),
        sourceEntries,
        embeddedPaths,
      });
      for (const record of sourceEntries.entries) {
        graph.addEntry(record.output);
      }
      if (leaf) {
        graph.addSource(leaf, config);
      }
      const adapter = createStandaloneSourceTransforms({
        sourceRoot,
        runtimeRoot,
        parse: createStandaloneSourceParser(),
        resolveModule: () => companion,
        emitChunk: graph.addEmittedChunk,
      });
      const transformed = await adapter.transform({ filename: setup, contents: source, config });
      const sdk =
        "data:text/javascript,export const defineBundledChannelSetupEntry = value => value;";
      const executable = `const globalThis = { __openclawStandaloneRootUrl: ${JSON.stringify(pathToFileURL(runtimeRoot + path.sep).href)} };\n${transformed.contents.replace('"openclaw/plugin-sdk/channel-entry-contract"', JSON.stringify(sdk))}`;
      const declaration = (await import(`data:text/javascript,${encodeURIComponent(executable)}`))
        .default;
      const resolved = declaration.legacySessionSurface.specifier;
      const relative = path.relative(runtimeRoot, resolved).split(path.sep).join("/");
      expect(relative).toMatch(/^dist\/extensions\/demo\//);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, relative), resolved);
      const opened = openRootFileSync({
        absolutePath: resolved,
        rootPath: path.join(runtimeRoot, pluginRoot),
        boundaryLabel: "plugin root",
        rejectHardlinks: false,
        skipLexicalRootCheck: true,
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        fs.closeSync(opened.fd);
      }
      const embedded = embeddedPaths[relative];
      if (!embedded) {
        throw new Error("Missing embedded companion path");
      }
      expect(embedded).toMatch(/^\/\$bunfs\/root\//);
      const staged = path.join(path.dirname(runtimeRoot), embedded.slice("/$bunfs/root/".length));
      expect(graph.roots.has(staged)).toBe(true);
      expect(graph.files.get(staged)?.context.config).toBe(config);
      const otherEntry = embeddedPaths[`dist/${setupName}.js`];
      if (!otherEntry) {
        throw new Error("Missing embedded setup entry");
      }
      embeddedPaths[relative] = otherEntry;
      expect(() => graph.addEmittedChunk({ id: companion, config })).toThrow(
        "Conflicting standalone emitted chunk",
      );
      expect(embeddedPaths[relative]).toBe(otherEntry);
      embeddedPaths[relative] = embedded;
      fs.unlinkSync(companion);
      expect((await import(pathToFileURL(staged).href)).marker).toBe(73);
    },
  );

  it("uses isolated plugin and worker metadata after fresh build and cache restore", async () => {
    const { root, sourceRoot, write } = fixture();
    const packageDir = path.join(sourceRoot, "extensions/codex");
    writeJsonFile(path.join(packageDir, "package.json"), {
      name: "@openclaw/codex",
      type: "module",
      version: "1.0.0",
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
        build: {
          runtimeFormat: "cjs",
          bundledDist: false,
          workerEntries: ["./catalog-page.worker.ts"],
        },
        release: { publishToNpm: true },
      },
    });
    write("extensions/codex/openclaw.plugin.json", JSON.stringify({ id: "codex" }));
    for (const name of ["index", "setup-entry", "catalog-page.worker"]) {
      write(`extensions/codex/${name}.ts`, 'export { readBuildInfo } from "./src/identity.ts";\n');
    }
    const helper = write("extensions/codex/src/identity.ts", helperContents);
    const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot: sourceRoot, packageDir });
    assert(plan, "Missing isolated plugin fixture plan");
    const configs = createPluginNpmRuntimeBuildOptions(plan, { logLevel: "silent" }).map((config) =>
      Object.assign(config, { cwd: sourceRoot }),
    );
    const [config, workerConfig] = configs;
    assert(config && workerConfig, "Missing isolated plugin build groups");
    const index = () =>
      createStandaloneSourceEntries({
        sourceRoot,
        configs: [],
        pluginEntries: [
          {
            id: "codex",
            isolated: true,
            sourceEntries: plan.sourceEntries,
            runtimeExtension: ".cjs",
            runtimeBuildConfigs: configs,
            runtimeBuildPlan: plan,
          },
        ],
      });
    await buildExternalPluginLocalDist({ repoRoot: sourceRoot, env: {}, logLevel: "silent" });
    expect(fs.existsSync(plan.outDir)).toBe(false);
    const entries = index();
    const output = entries.resolveModuleUrl(helper, config);
    const workerOutput = entries.resolveModuleUrl(helper, workerConfig);
    expect(workerOutput).toBe("dist/extensions/codex/catalog-page.worker.cjs");
    expect(entries.resolve(workerOutput)?.contextId).not.toBe(
      entries.resolve("dist/extensions/codex/index.cjs")?.contextId,
    );
    expect(output).toMatch(/^dist\/extensions\/codex\/\.setup\/.*\.cjs$/);
    expect(output).not.toContain("extensions/codex/dist");
    fs.rmSync(path.join(sourceRoot, "dist"), { recursive: true });
    await buildExternalPluginLocalDist({ repoRoot: sourceRoot, env: {}, logLevel: "silent" });
    expect(fs.existsSync(plan.outDir)).toBe(false);
    expect(index().resolveModuleUrl(helper, config)).toBe(output);
    expect(index().resolveModuleUrl(helper, workerConfig)).toBe(workerOutput);
    runRelocatedHelper(root, sourceRoot, workerOutput);
  });
});
