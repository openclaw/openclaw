import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { resolveRepoToolBinPath } from "../../scripts/lib/local-check-runtime.mts";
import { TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS } from "../../scripts/lib/tsdown-config-groups.mts";
import type { CommandFixture } from "../helpers/command-fixture.js";
import {
  createDeclarationFixture,
  createDeclarationTest,
  declarationCacheRecords,
  expectStagingClean,
  runFixtureModule,
  runWriter,
  treeHashes,
} from "./tsdown-declaration-fixture.js";

const it = createDeclarationTest();
const coreText = (origin: string) =>
  `export interface Marker { origin: "${origin}" }\ndeclare global { const declarationOrigin: "${origin}"; }\n`;

function writeFiles(write: (file: string, text: string) => void, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    write(file, text);
  }
}

function typesPackage(directory: string, name: string, source: string, version = "2.0.0") {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: `@types/${name}`, version, types: "index.d.ts" }),
  );
  fs.writeFileSync(path.join(directory, "index.d.ts"), source);
}

async function runModule(command: CommandFixture, root: string, source: string) {
  const result = await runFixtureModule(
    command,
    root,
    `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const dispose = async bundles => { for (const bundle of bundles) await bundle[Symbol.asyncDispose](); };
const makeBuild = build => options => build({ ...options, config: options.config ?? false, clean: false, logLevel: "silent" });
${source}`,
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

function createFixture(
  command: CommandFixture,
  groups?: readonly string[],
  root?: string,
  extraEntrypoints?: readonly string[],
) {
  const fixture = createDeclarationFixture(command, groups, root, extraEntrypoints);
  if (extraEntrypoints?.includes("tsdown.ai.config.ts")) {
    // The real AI build copies its bundled SDK's license alongside every output.
    const license = "node_modules/@mistralai/mistralai/LICENSE";
    fixture.write(license, fs.readFileSync(license, "utf8"));
  }
  return { ...fixture, run: (source: string) => runModule(command, fixture.root, source) };
}

function containedFixture(
  command: CommandFixture,
  groups: readonly string[] = TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
  extraEntrypoints: readonly string[] = [],
) {
  const ancestor = fs.realpathSync.native(
    command.createTempDir("openclaw-declaration-resolution-"),
  );
  const root = path.join(ancestor, ".claude/worktrees/validation");
  const fixture = createFixture(command, groups, root, extraEntrypoints);
  const ancestorPackage = path.join(ancestor, "node_modules/@types/synthetic-core");
  const ancestorInput = path.join(ancestorPackage, "index.d.ts");
  const wrapper = "node_modules/.pnpm/wrapper/node_modules/@types/synthetic-wrapper";
  const local = "node_modules/.pnpm/core/node_modules/@types/synthetic-core";
  typesPackage(
    path.join(root, wrapper),
    "synthetic-wrapper",
    '/// <reference types="synthetic-core" />\nexport type { Marker } from "synthetic-core";\n',
  );
  typesPackage(path.join(root, local), "synthetic-core", coreText("local"));
  typesPackage(
    path.join(root, "node_modules/@types/synthetic-automatic"),
    "synthetic-automatic",
    'declare function declarationDirectoryName(): "declared-cwd";\n',
  );
  const link = (target: string, alias: string) => {
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(alias), target), alias, "junction");
  };
  link(path.join(root, wrapper), path.join(root, "node_modules/@types/synthetic-wrapper"));
  link(path.join(root, local), path.join(root, path.dirname(wrapper), "synthetic-core"));
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")) as {
    compilerOptions: { types: string[] };
  };
  tsconfig.compilerOptions.types = ["synthetic-automatic"];
  fixture.write("tsconfig.json", JSON.stringify(tsconfig));
  fixture.write(
    "src/shared.ts",
    'import type { Marker } from "synthetic-wrapper";\nexport type { Marker };\nexport const inferredOrigin = declarationOrigin;\nexport function directoryName() { return declarationDirectoryName(); }\nexport class Shared { private brand = "canonical"; }\n',
  );
  const entry = Object.values(fixture.declarations).flat()[0]!;
  fs.appendFileSync(
    path.join(root, entry),
    '\nexport { inferredOrigin } from "@openclaw/llm-core";\n',
  );
  return { ...fixture, ancestorInput, localInput: `${local}/index.d.ts` };
}

function nestedFixture(
  command: CommandFixture,
  groups: readonly string[] = TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
) {
  const fixture = containedFixture(command, groups);
  typesPackage(
    path.dirname(fixture.ancestorInput),
    "synthetic-core",
    coreText("ancestor"),
    "1.0.0",
  );
  return fixture;
}

it.concurrent("bounds standalone package builds while preserving public declarations and sibling outputs", ({
  command,
}) =>
  command.lifetime.run(async () => {
    const { root, write, run } = containedFixture(command, undefined, [
      "scripts/build-workspace-package.mts",
    ]);
    fs.symlinkSync(
      fs.realpathSync("node_modules/semver"),
      path.join(root, "node_modules/semver"),
      "junction",
    );
    const manifest = JSON.parse(
      fs.readFileSync("packages/gateway-client/package.json", "utf8"),
    ) as {
      exports: Record<string, { import: string; types: string }>;
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = { ...manifest.dependencies, "standalone-dependency": "1.0.0" };
    write("packages/gateway-client/package.json", JSON.stringify(manifest));
    writeFiles(write, {
      "node_modules/standalone-dependency/package.json": JSON.stringify({
        name: "standalone-dependency",
        version: "1.0.0",
        type: "module",
        exports: { "./value": { types: "./value.d.ts", import: "./value.js" } },
      }),
      "node_modules/standalone-dependency/value.d.ts":
        "export declare const externalValue: string;",
      "node_modules/standalone-dependency/value.js":
        'export const externalValue = "package-owned";',
      "packages/sdk/src/index.ts": 'export const sdkMarker = "sdk";\n',
      // TS4094 in an unselected helper must not poison package compilation.
      "src/unrelated.test-support.ts":
        "export const hidden = new (class { private value = 1; })();\n",
      "packages/gateway-client/dist/obsolete.d.mts": "export declare const retired: 1;",
      "dist/keep.txt": "root output",
      "packages/gateway-protocol/dist/keep.txt": "sibling output",
    });
    for (const entry of Object.values(manifest.exports)) {
      write(
        entry.import.replace("./dist/", "packages/gateway-client/src/").replace(/\.mjs$/u, ".ts"),
        'export const marker = "bounded";\n',
      );
    }
    write(
      "packages/gateway-client/src/index.ts",
      `
      export const marker = "bounded";
      export { externalValue } from "standalone-dependency/value";
      declare const process: { env: { NODE_ENV?: string } };
      export function runtimeMode(env: { NODE_ENV?: string }) {
        return env.NODE_ENV ?? process.env.NODE_ENV;
      }
    `,
    );
    await run(`
import { pathToFileURL } from "node:url";
import { buildWorkspacePackage } from "./scripts/build-workspace-package.mts";
import configs from "./tsdown.config.ts";
for (const [name, target] of [["sdk", undefined], ["gateway-client", ["node22.19.0"]]]) {
  const config = configs.find(config => config.outDir === "packages/" + name + "/dist");
  const original = config.hooks;
  config.hooks = async hooks => {
    await original(hooks);
    hooks.hook("build:prepare", ({ options }) => assert.deepEqual(options.target, target));
  };
}
await buildWorkspacePackage("sdk");
assert.match(fs.readFileSync("packages/sdk/dist/index.d.mts", "utf8"), /sdkMarker.*"sdk"/);
process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = "1";
const packageDir = path.join(root, "packages/gateway-client");
process.chdir(packageDir);
await buildWorkspacePackage("gateway-client");
assert.equal(process.cwd(), packageDir);
assert.equal(fs.existsSync("dist/obsolete.d.mts"), false);
fs.writeFileSync(path.join(root, "node_modules/standalone-dependency/value.js"), 'export const externalValue = "installed-update";');
process.env.NODE_ENV = "runtime-mode";
const output = await import(pathToFileURL(path.join(packageDir, "dist/index.mjs")).href);
assert.deepEqual(
  { mode: output.runtimeMode({}), external: output.externalValue },
  { mode: "runtime-mode", external: "installed-update" },
);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const entry of Object.values(manifest.exports)) {
  assert.ok(fs.existsSync(entry.import), entry.import);
  assert.match(fs.readFileSync(entry.types, "utf8"), /marker.*"bounded"/);
}
assert.equal(fs.readFileSync(path.join(root, "dist/keep.txt"), "utf8"), "root output");
assert.equal(fs.readFileSync(path.join(root, "packages/gateway-protocol/dist/keep.txt"), "utf8"), "sibling output");
fs.writeFileSync("src/index.ts", 'export const invalid: number = "selected";');
await assert.rejects(buildWorkspacePackage("gateway-client"), /TS2322/);
assert.equal(process.cwd(), packageDir);
`);
  }));

for (const kind of [
  "directory alias",
  "Windows 8.3 alias",
  "directory alias targeting a case alias",
]) {
  it.skipIf(kind.includes("Windows") && process.platform !== "win32").concurrent(
    `compiles and receipts every local input through a ${kind}`,
    ({ command, skip }) =>
      command.lifetime.run(async () => {
        const { root, ancestorInput, localInput } = nestedFixture(command);
        let target = root;
        if (kind.includes("Windows")) {
          const short = spawnSync(
            "cmd.exe",
            ["/d", "/c", 'for %I in ("%DECLARATION_ALIAS_ROOT%") do @echo %~sI'],
            {
              encoding: "utf8",
              // cmd.exe owns this command's quotes; libuv must not backslash-escape them.
              windowsVerbatimArguments: true,
              env: { ...process.env, DECLARATION_ALIAS_ROOT: root },
            },
          );
          expect(short.status, short.stderr).toBe(0);
          target = short.stdout.trim();
          expect(fs.realpathSync.native(target)).toBe(root);
          if (fs.realpathSync(target).toLowerCase() === root.toLowerCase()) {
            skip("Filesystem does not expose a distinct Windows 8.3 checkout alias");
          }
        } else if (kind.endsWith("case alias")) {
          target = path.join(path.dirname(root), path.basename(root).toUpperCase());
          if (!fs.existsSync(target)) {
            skip("Filesystem does not expose a case-insensitive checkout alias");
          }
          expect(fs.realpathSync.native(target)).toBe(root);
        }
        let alias = target;
        if (kind.startsWith("directory alias")) {
          alias = `${root}-alias`;
          fs.symlinkSync(target, alias, "junction");
        }
        if (kind.startsWith("directory alias targeting")) {
          // Keep all three inputs distinct even when the runtime canonicalizes the
          // case-only target before realpath returns it.
          expect(alias).not.toBe(target);
          expect(target).not.toBe(root);
        }
        const dist = path.join(root, "dist");
        fs.mkdirSync(dist, { recursive: true });
        // An installed alias exposes live output to topology scanning. Its physical
        // owner must still be excluded when the writer starts through a short cwd.
        fs.symlinkSync(dist, path.join(root, "node_modules/fixture-published"), "junction");
        const cold = await runWriter(command, alias);
        expect(cold.status, cold.stdout + cold.stderr).toBe(0);
        const inputs = declarationCacheRecords(root).flatMap((record) => record.inputs ?? []);
        expect(inputs).toEqual(expect.arrayContaining([localInput, "src/shared.ts"]));
        expect(inputs.some((file) => file.endsWith("/lib.es2023.d.ts"))).toBe(true);
        expect(inputs.some((file) => file.endsWith("synthetic-core/package.json"))).toBe(true);
        for (const input of inputs) {
          const relative = path.relative(root, fs.realpathSync(path.resolve(root, input)));
          expect(
            relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
            input,
          ).toBe(false);
        }
        const published = treeHashes(dist);
        const declarations = Object.keys(published)
          .filter((file) => file.endsWith(".d.ts"))
          .map((file) => fs.readFileSync(path.join(dist, file), "utf8"))
          .join("\n");
        expect(declarations.match(/declare const inferredOrigin: [^;]+;/u)?.[0]).toBe(
          'declare const inferredOrigin: "local";',
        );
        const cache = path.join(root, ".artifacts/build-all-cache");
        const cached = treeHashes(cache);
        fs.writeFileSync(ancestorInput, coreText("changed-ancestor"));
        const warm = await runWriter(command, alias);
        expect(warm.status, warm.stdout + warm.stderr).toBe(0);
        expect(warm.stdout + warm.stderr).not.toContain("[tsdown-build] invocation");
        expect(treeHashes(dist)).toEqual(published);
        expect(treeHashes(cache)).toEqual(cached);
        expectStagingClean(root);
      }),
  );
}

it.concurrent("preserves object and registration hooks while enforcing the declaration boundary", ({
  command,
}) =>
  command.lifetime.run(async () => {
    const { run } = containedFixture(command);
    await run(`
import { build } from "tsdown";
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
const buildFixture = makeBuild(build);
for (const registration of [false, true]) {
  const calls = [];
  const existing = {
    "build:prepare": async () => { await Promise.resolve(); calls.push("prepare"); },
    "build:done": () => { calls.push("done"); },
  };
  const hooks = createDeclarationBoundaryHooks(registration
    ? async hooks => { hooks.addHooks(existing); }
    : existing);
  const outDir = ".artifacts/hook-composition-" + registration;
  const { bundles } = await buildFixture({ entry: "src/shared.ts", dts: { newContext: true }, outDir, hooks });
  try {
    assert.deepEqual(calls, ["prepare", "done"]);
    assert.match(fs.readFileSync(outDir + "/shared.d.mts", "utf8"), /inferredOrigin: "local"/);
  } finally {
    await dispose(bundles);
  }
}
`);
  }));

it.concurrent("preserves inherited ambient declarations without admitting unrelated source roots", ({
  command,
}) =>
  command.lifetime.run(async () => {
    const { write, run } = createFixture(command);
    writeFiles(write, {
      "config/ambient.json": JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["../src/ambient/**/*.ts"],
      }),
      "tsconfig.json": '{"extends":"./config/ambient.json"}',
      "src/ambient/types/qrcode.d.ts":
        'declare module "synthetic-qrcode" { export function encode(value: string): { data: string }; }\n',
      "src/ambient/consumer.ts":
        'import { encode } from "synthetic-qrcode";\nexport function render(value: string) { return encode(value); }\n',
      "src/ambient/unrelated.ts": 'export const unrelated: number = "invalid";\n',
      "node_modules/synthetic-qrcode/package.json": '{"type":"module","main":"./index.js"}',
      "node_modules/synthetic-qrcode/index.js":
        "export function encode(value) { return { data: value }; }\n",
    });
    await run(`
import { build } from "tsdown";
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
import { createDeclarationStage, createDeclarationInputCapture, requestDeclarationInputs, readDeclarationInputs } from "./scripts/lib/tsdown-declaration-inputs.mts";
const buildFixture = makeBuild(build);
const stage = createDeclarationStage(root);
const outDir = path.join(stage, "dist");
const entry = "src/ambient/consumer.ts";
requestDeclarationInputs(outDir, "ambient", [entry]);
const options = { cwd: root, entry, outDir, dts: true,
  fixedExtension: true, hooks: createDeclarationBoundaryHooks({
    "build:done": createDeclarationInputCapture("ambient"),
  }) };
try {
  const { bundles } = await buildFixture(options);
  await dispose(bundles);
  const membership = readDeclarationInputs(outDir, "ambient");
  assert.ok(membership.includes("src/ambient/types/qrcode.d.ts"), "configured ambient root was omitted");
  assert.equal(membership.includes("src/ambient/unrelated.ts"), false, "unrelated source entered the compiler");
  assert.equal(fs.readdirSync(outDir).some(file => file.includes("unrelated")), false);
  const declaration = path.join(outDir, "consumer.d.mts");
  const before = fs.readFileSync(declaration, "utf8");
  assert.match(before, /data: string/);
  fs.writeFileSync(path.join(root, entry), 'export const rejected: number = "invalid";\\n');
  await assert.rejects(buildFixture(options), /TS2322/);
  assert.equal(fs.readFileSync(declaration, "utf8"), before, "failed checking replaced declarations");
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
`);
  }));

it.skipIf(process.platform === "win32").concurrent(
  "admits cold sibling workspace outputs through installed aliases",
  ({ command }) =>
    command.lifetime.run(async () => {
      const { root, write, run } = createFixture(command);
      write("src/consumer.ts", "export const consumer = 1;\n");
      write("packages/output-producer/package.json", '{"type":"module"}');
      write("packages/output-producer/index.ts", "export const produced = 2;\n");
      const alias = path.join(
        root,
        "node_modules/.pnpm/node_modules/synthetic-host/node_modules/synthetic-producer",
      );
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(path.join(root, "packages/output-producer"), alias, "junction");
      write(
        "tsdown.sibling.config.mts",
        `
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
export default [
  { entry: "src/consumer.ts", outDir: ".artifacts/consumer-output", dts: true,
    hooks: createDeclarationBoundaryHooks() },
  { entry: "packages/output-producer/index.ts", outDir: "packages/output-producer/dist", dts: true,
    hooks: createDeclarationBoundaryHooks(), plugins: [{
      name: "fixture-sibling-order",
      buildStart() { return globalThis.consumerStarted; },
      writeBundle() { globalThis.finishProducer(); },
      buildEnd(error) { if (error) globalThis.finishProducer(); },
      renderError() { globalThis.finishProducer(); },
    }] },
];
`,
      );
      await run(`
import { Program } from "typescript/async";
import { build } from "tsdown";
const buildFixture = makeBuild(build);
const output = path.join(root, "packages/output-producer/dist");
const alias = ${JSON.stringify(alias)};
assert.equal(fs.existsSync(output), false, "the producer must start cold");
const originalEmit = Program.prototype.emitToString;
const started = Promise.withResolvers();
const written = Promise.withResolvers();
let compilers = 0;
globalThis.consumerStarted = started.promise;
globalThis.finishProducer = written.resolve;
Program.prototype.emitToString = async function (...args) {
  const output = await originalEmit.apply(this, args);
  if ((await this.getSourceFileNames()).includes(path.join(root, "src/consumer.ts"))) {
    compilers++;
    started.resolve();
    // Delay only result delivery until the real sibling build writes its output.
    await written.promise;
  }
  return output;
};
try {
  const { bundles } = await buildFixture({ config: "tsdown.sibling.config.mts" });
  await dispose(bundles);
  assert.equal(compilers, 1);
  for (const file of ["index.mjs", "index.d.mts"]) {
    assert.ok(fs.existsSync(path.join(alias, "dist", file)), "missing sibling " + file);
  }
} finally {
  written.resolve();
  Program.prototype.emitToString = originalEmit;
}
`);
    }),
);

it.concurrent.for(
  ["node", "workspace", "AI"].flatMap((owner) => [true, false].map((dts) => ({ owner, dts }))),
)("honors resolved dts=$dts over the opposite $owner default", ({ owner, dts }, { command }) =>
  command.lifetime.run(async () => {
    const { root, run } = containedFixture(command, undefined, ["tsdown.ai.config.ts"]);
    const outside = path.join(path.dirname(root), "runtime.ts");
    fs.writeFileSync(outside, 'export const runtimeValue = "outside-runtime";');
    await run(`
import { build } from "tsdown";
const buildFixture = makeBuild(build);
process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = ${JSON.stringify(dts ? "1" : "0")};
const { default: configs } = await import("./tsdown.config.ts");
const { default: ai } = await import("./tsdown.ai.config.ts");
const owner = ${JSON.stringify(owner)};
const config = owner === "AI" ? ai : configs.find(config => config.outDir ===
  (owner === "node" ? "packages/agent-core/dist" : "packages/gateway-protocol/dist"));
assert.ok(config);
assert.deepEqual(config.dts, ${dts ? "false" : '{ tsconfig: "tsconfig.packages.json" }'});
// The build API's cwd, rather than the importing process's cwd, owns inputs.
process.chdir(path.dirname(root));
const runtime = Promise.withResolvers();
const { bundles } = await buildFixture({
  ...config, cwd: root,
  dts: ${dts ? '{ enabled: true, entry: ["src/shared.ts"], newContext: true }' : owner === "AI" ? "{ enabled: false }" : "false"}, format: ["esm", "cjs"], concurrency: 1,
  entry: ${JSON.stringify(dts ? "src/shared.ts" : outside)},
  outDir: "override-output", outExtensions: undefined, fixedExtension: true,
  inputOptions: async (input, format, context) => {
    const resolved = await config.inputOptions?.(input, format, context) ?? input;
    return { ...resolved, plugins: [resolved.plugins, {
      name: "fixture-independent-cjs",
      buildStart: { order: context.cjsDts ? "post" : "pre", async handler() {
        // CJS declarations must remain bounded after the runtime sibling finishes.
        if (context.cjsDts) await runtime.promise;
      } },
      buildEnd: { order: "post", handler() {
        if (format === "cjs" && !context.cjsDts) runtime.resolve();
      } },
    }] };
  },
});
try {
  const files = fs.readdirSync(path.join(root, "override-output"));
  if (${dts}) {
    for (const extension of ["mts", "cts"]) {
      const declaration = fs.readFileSync(path.join(root, "override-output/shared.d." + extension), "utf8");
      assert.match(declaration, /inferredOrigin: "local"/, extension + " used ancestor declarations");
      assert.match(declaration, /directoryName\\(\\): "declared-cwd"/, extension + " lost automatic types from declared cwd");
    }
  } else {
    assert.equal(files.some(file => /\\.d\\.[cm]?ts$/.test(file)), false);
    for (const extension of ["mjs", "cjs"]) {
      assert.match(fs.readFileSync(path.join(root, "override-output/runtime." + extension), "utf8"), /outside-runtime/);
    }
  }
  if (${dts && owner === "AI"}) {
    let starts = 0;
    const { bundles: objectOptions } = await buildFixture({
      ...config, cwd: root,
      dts: { cwd: path.join(root, "src"), entry: ["shared.ts"] }, format: "cjs", entry: "src/shared.ts", outDir: "object-options-output",
      inputOptions: { plugins: [{ name: "fixture-object-options", buildStart() { starts++; } }] },
    });
    try {
      assert.equal(starts, 2, "object inputOptions plugin must run for runtime and declarations");
      assert.match(fs.readFileSync(path.join(root, "object-options-output/shared.d.cts"), "utf8"), /inferredOrigin: "local"/);
      assert.match(fs.readFileSync(path.join(root, "object-options-output/shared.d.cts"), "utf8"), /directoryName\\(\\): "declared-cwd"/);
    } finally {
      await dispose(objectOptions);
    }
  }
} finally {
  await dispose(bundles);
}
`);
  }),
);

it.concurrent("isolates native compilation across overlapping workspace and AI builds, including failures", ({
  command,
}) =>
  command.lifetime.run(async () => {
    const { write, run } = containedFixture(command, undefined, ["tsdown.ai.config.ts"]);
    write(
      "src/second.ts",
      'import "synthetic-wrapper"; export const secondOrigin = declarationOrigin;',
    );
    await run(`
import { build } from "tsdown";
const buildFixture = makeBuild(build);
const { default: configs } = await import("./tsdown.config.ts");
const { default: ai } = await import("./tsdown.ai.config.ts");
const workspace = configs.find(config => config.outDir === "packages/gateway-protocol/dist");
assert.ok(workspace);
process.chdir(path.dirname(root));
for (const failure of [false, true]) {
  let started = 0;
  const first = Promise.withResolvers();
  const barrier = Promise.withResolvers();
  const launch = (config, index) => buildFixture({
    ...config, cwd: root,
    entry: index ? "src/second.ts" : "src/shared.ts",
    outDir: ".artifacts/lifecycle-" + index,
    plugins: [config.plugins, {
      name: "fixture-lifecycle",
      buildStart: { order: "post", async handler() {
        assert.equal(process.cwd(), path.dirname(root), "native compilation changed process cwd");
        if (++started === 2) barrier.resolve();
        await barrier.promise;
        if (index) {
          await first.promise;
          if (failure) throw new Error("fixture buildStart failure");
        }
      } },
    }],
  });
  const results = await Promise.allSettled([
    launch(workspace, 0).finally(() => first.resolve()),
    launch(ai, 1),
  ]);
  assert.equal(results[0].status, "fulfilled", results[0].reason?.stack);
  assert.equal(results[1].status, failure ? "rejected" : "fulfilled", results[1].reason?.stack);
  assert.equal(fs.readdirSync(path.join(root, ".artifacts")).some(name => name.startsWith("native-declarations-")), false, "native stage leaked after settled builds");
  if (!failure) {
    assert.match(fs.readFileSync(path.join(root, ".artifacts/lifecycle-1/second.d.mts"), "utf8"), /secondOrigin: "local"/);
  }
}
`);
  }));

it.concurrent.for([
  "ancestor module",
  "ancestor package alias",
  "ancestor ambient types",
  "package symlink",
  "source symlink",
  "source reference",
])("refuses an escaped %s before publication", (kind, { command }) =>
  command.lifetime.run(async () => {
    const ancestorLookup = [
      "ancestor module",
      "ancestor package alias",
      "ancestor ambient types",
    ].includes(kind);
    const { root, write, ancestorInput, localInput } = ancestorLookup
      ? nestedFixture(command)
      : containedFixture(command);
    let rejectedPath = ancestorLookup ? path.dirname(ancestorInput) : `${root}-outside`;
    const outside = `${root}-outside`;
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "index.d.ts"), "export interface Marker { escaped: true }");
    if (kind === "ancestor module" || kind === "ancestor package alias") {
      if (kind === "ancestor package alias") {
        fs.rmSync(path.dirname(ancestorInput), { recursive: true });
        fs.symlinkSync(
          path.join(root, path.dirname(localInput)),
          path.dirname(ancestorInput),
          "junction",
        );
      }
      write("src/shared.ts", 'export type { Marker as Shared } from "synthetic-core";');
    } else if (kind === "ancestor ambient types") {
      const ambient = path.join(path.dirname(path.dirname(ancestorInput)), "synthetic-ambient");
      fs.mkdirSync(ambient);
      fs.writeFileSync(
        path.join(ambient, "index.d.ts"),
        'declare module "*" { export const marker: "ancestor"; }\n',
      );
      write(
        "src/shared.ts",
        `/// <reference path="${path.join(ambient, "index.d.ts").replaceAll(path.sep, "/")}" />\nimport { marker } from "otherwise-unresolved";\nexport class Shared {}\nexport const adopted = marker;\n`,
      );
      const positiveConfig = path.join(root, ".artifacts/ambient-positive.json");
      fs.writeFileSync(
        positiveConfig,
        JSON.stringify({
          extends: path.join(root, "tsconfig.json"),
          compilerOptions: { noEmit: true },
          files: [path.join(root, "src/shared.ts")],
          include: [],
        }),
      );
      const positive = spawnSync(
        resolveRepoToolBinPath("tsgo", { cwd: root }),
        ["-p", positiveConfig, "--pretty", "false"],
        { cwd: root, encoding: "utf8" },
      );
      expect(positive.error).toBeUndefined();
      expect(positive.signal).toBeNull();
      expect(positive.status, positive.stdout + positive.stderr).toBe(0);
      rejectedPath = ambient;
    } else if (kind === "package symlink") {
      fs.writeFileSync(
        path.join(outside, "package.json"),
        '{"name":"escaped","types":"index.d.ts"}',
      );
      fs.symlinkSync(outside, path.join(root, "node_modules/escaped"), "junction");
      write("src/shared.ts", 'export type { Marker as Shared } from "escaped";');
    } else if (kind === "source symlink") {
      fs.symlinkSync(path.join(outside, "index.d.ts"), path.join(root, "src/escaped.d.ts"));
      write("src/shared.ts", 'export type { Marker as Shared } from "./escaped.js";');
    } else {
      write(
        "src/shared.ts",
        `/// <reference path="${path.join(outside, "index.d.ts").replaceAll(path.sep, "/")}" />\nexport class Shared {}\n`,
      );
    }
    fs.appendFileSync(
      path.join(root, "src/shared.ts"),
      '\nexport const inferredOrigin = "unused";\n',
    );
    write("dist/plugin-sdk/core.d.ts", "previous declaration");
    const before = treeHashes(path.join(root, "dist"));
    const failed = await runWriter(command, root);
    expect(failed.status, failed.stdout + failed.stderr).toBeGreaterThan(0);
    if (["ancestor module", "ancestor package alias"].includes(kind)) {
      expect(failed.stdout + failed.stderr).toContain("TS2307");
    } else if (kind.includes("reference") || kind === "ancestor ambient types") {
      expect(failed.stdout + failed.stderr).toContain("TS6053");
    } else {
      expect(failed.stdout + failed.stderr).toContain("Declaration input escapes checkout");
      expect(failed.stdout + failed.stderr).toContain(rejectedPath);
    }
    expect(treeHashes(path.join(root, "dist"))).toEqual(before);
    expectStagingClean(root);
  }),
);
