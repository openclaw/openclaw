import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRepoToolBinPath } from "../../scripts/lib/local-check-runtime.mts";
import {
  TSDOWN_NON_SDK_DTS_CONFIG_GROUPS,
  TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
} from "../../scripts/lib/tsdown-config-groups.mts";
import { prepareTsgoCommand } from "../../scripts/run-tsgo.mts";
import { materializeNativeCompiler } from "./native-boundary-fixture.js";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  createFixture,
  declarationCacheRecords,
  expectStagingClean,
  runFixtureModule,
  runUnifiedWriter,
  runWriter,
  treeHashes,
} from "./tsdown-declaration-fixture.js";

const { createTempDir } = createScriptTestHarness();
const coreText = (origin: string) =>
  `export interface Marker { origin: "${origin}" }\ndeclare global { const declarationOrigin: "${origin}"; }\n`;

function containedFixture(groups: readonly string[] = TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS) {
  const ancestor = fs.realpathSync.native(createTempDir("openclaw-declaration-resolution-"));
  const root = path.join(ancestor, ".claude/worktrees/validation");
  const fixture = createFixture(groups, root);
  const ancestorPackage = path.join(ancestor, "node_modules/@types/synthetic-core");
  const ancestorInput = path.join(ancestorPackage, "index.d.ts");
  const wrapper = "node_modules/.pnpm/wrapper/node_modules/@types/synthetic-wrapper";
  const local = "node_modules/.pnpm/core/node_modules/@types/synthetic-core";
  for (const [directory, name, text] of [
    [
      wrapper,
      "synthetic-wrapper",
      '/// <reference types="synthetic-core" />\nexport type { Marker } from "synthetic-core";\n',
    ],
    [local, "synthetic-core", coreText("local")],
    [
      "node_modules/@types/synthetic-automatic",
      "synthetic-automatic",
      'declare function declarationDirectoryName(): "declared-cwd";\n',
    ],
  ] as const) {
    fixture.write(
      `${directory}/package.json`,
      JSON.stringify({ name: `@types/${name}`, version: "2.0.0", types: "index.d.ts" }),
    );
    fixture.write(`${directory}/index.d.ts`, text);
  }
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

function nestedFixture(groups: readonly string[] = TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS) {
  const fixture = containedFixture(groups);
  const ancestorPackage = path.dirname(fixture.ancestorInput);
  fs.mkdirSync(ancestorPackage, { recursive: true });
  fs.writeFileSync(
    path.join(ancestorPackage, "package.json"),
    JSON.stringify({ name: "@types/synthetic-core", version: "1.0.0", types: "index.d.ts" }),
  );
  fs.writeFileSync(fixture.ancestorInput, coreText("ancestor"));
  return fixture;
}

describe("tsdown checkout declaration resolution", () => {
  it.runIf(process.platform === "win32")(
    "starts the checkout compiler when its Windows executable uses an extended-length path",
    () => {
      const root = path.join(
        fs.realpathSync.native(createTempDir("openclaw-native-long-path-")),
        "nested-checkout-".repeat(5),
        "nested-install-".repeat(5),
      );
      fs.mkdirSync(root, { recursive: true });
      const native = materializeNativeCompiler(root);
      expect(native.length).toBeGreaterThanOrEqual(248);
      const require = createRequire(path.join(root, "package.json"));
      const getExePath: { default: () => string } = require(
        path.join(root, "node_modules/typescript/lib/getExePath.js"),
      );
      expect(getExePath.default()).toBe(path.toNamespacedPath(native));
      const command = prepareTsgoCommand(["--version"], process.env, root);
      expect(command?.bin).toBe(getExePath.default());
      const result = spawnSync(resolveRepoToolBinPath("tsgo", { cwd: root }), ["--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      const manifest: { version: string } = JSON.parse(
        fs.readFileSync(require.resolve("typescript/package.json"), "utf8"),
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`Version ${manifest.version}`);
    },
  );

  for (const kind of [
    "directory alias",
    "Windows 8.3 alias",
    "directory alias targeting Windows 8.3",
    "directory alias targeting a case alias",
  ]) {
    it.skipIf(kind.includes("Windows") && process.platform !== "win32")(
      `compiles and receipts every local input through a ${kind}`,
      (context) => {
        const { root, localInput } = nestedFixture();
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
            context.skip("Filesystem does not expose a distinct Windows 8.3 checkout alias");
          }
        } else if (kind.endsWith("case alias")) {
          target = path.join(path.dirname(root), path.basename(root).toUpperCase());
          if (!fs.existsSync(target)) {
            context.skip("Filesystem does not expose a case-insensitive checkout alias");
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
        const result = runFixtureModule(
          root,
          `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
import { createDeclarationStage, createDeclarationInputCapture, requestDeclarationInputs, readDeclarationInputs } from "./scripts/lib/tsdown-declaration-inputs.mts";
const cwd = ${JSON.stringify(alias)};
const canonical = fs.realpathSync.native(cwd);
const stage = createDeclarationStage(cwd);
const outDir = path.join(cwd, path.relative(canonical, fs.realpathSync.native(stage)), "dist");
requestDeclarationInputs(outDir, "alias", [path.join(cwd, "src/shared.ts")]);
const { bundles } = await build({
  config: false, cwd, entry: path.join(cwd, "src/shared.ts"), outDir,
  dts: true, clean: false, logLevel: "silent",
  hooks: createDeclarationBoundaryHooks({ "build:done": createDeclarationInputCapture("alias") }),

});
try {
  const declaration = fs.readFileSync(path.join(outDir, "shared.d.mts"), "utf8");
  assert.match(declaration, /inferredOrigin: "local"/);
  assert.match(declaration, /directoryName\\(\\): "declared-cwd"/);
  const inputs = readDeclarationInputs(outDir, "alias");
  assert.ok(inputs.includes(${JSON.stringify(localInput)}));
  assert.ok(inputs.includes("src/shared.ts"));
  assert.ok(inputs.some(file => file.endsWith("/lib.es2023.d.ts")));
  assert.ok(inputs.some(file => file.endsWith("synthetic-core/package.json")));
  assert.ok(inputs.every(file => !file.startsWith("../")), "receipt admitted an outside input");
} finally {
  for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
  fs.rmSync(stage, { recursive: true, force: true });
}
`,
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        if (!kind.includes("Windows")) {
          return;
        }
        const dist = path.join(root, "dist");
        fs.mkdirSync(dist, { recursive: true });
        // An installed alias exposes live output to topology scanning. Its physical
        // owner must still be excluded when the writer starts through a short cwd.
        fs.symlinkSync(dist, path.join(root, "node_modules/fixture-published"), "junction");
        const cold = runWriter(alias);
        expect(cold.status, cold.stdout + cold.stderr).toBe(0);
        expect(declarationCacheRecords(root).flatMap((record) => record.inputs ?? [])).toContain(
          localInput,
        );
        const published = treeHashes(dist);
        const cache = path.join(root, ".artifacts/build-all-cache");
        const cached = treeHashes(cache);
        const warm = runWriter(alias);
        expect(warm.status, warm.stdout + warm.stderr).toBe(0);
        expect(warm.stdout + warm.stderr).not.toContain("[tsdown-build] invocation");
        expect(treeHashes(dist)).toEqual(published);
        expect(treeHashes(cache)).toEqual(cached);
        expectStagingClean(root);
      },
    );
  }

  it("preserves object and registration hooks while enforcing the declaration boundary", () => {
    const { root } = containedFixture();
    const result = runFixtureModule(
      root,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "tsdown";
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
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
  const { bundles } = await build({ config: false, entry: "src/shared.ts", dts: { newContext: true }, outDir, clean: false, logLevel: "silent", hooks });
  try {
    assert.deepEqual(calls, ["prepare", "done"]);
    assert.match(fs.readFileSync(outDir + "/shared.d.mts", "utf8"), /inferredOrigin: "local"/);
  } finally {
    for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
  }
}
`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("preserves inherited ambient declarations without admitting unrelated source roots", () => {
    const { root, write } = createFixture();
    write(
      "config/ambient.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["../src/ambient/**/*.ts"],
      }),
    );
    write("tsconfig.json", '{"extends":"./config/ambient.json"}');
    write(
      "src/ambient/types/qrcode.d.ts",
      'declare module "synthetic-qrcode" { export function encode(value: string): { data: string }; }\n',
    );
    write(
      "src/ambient/consumer.ts",
      'import { encode } from "synthetic-qrcode";\nexport function render(value: string) { return encode(value); }\n',
    );
    write("src/ambient/unrelated.ts", 'export const unrelated: number = "invalid";\n');
    write("node_modules/synthetic-qrcode/package.json", '{"type":"module","main":"./index.js"}');
    write(
      "node_modules/synthetic-qrcode/index.js",
      "export function encode(value) { return { data: value }; }\n",
    );
    const result = runFixtureModule(
      root,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
import { createDeclarationStage, createDeclarationInputCapture, requestDeclarationInputs, readDeclarationInputs } from "./scripts/lib/tsdown-declaration-inputs.mts";
const root = process.cwd();
const stage = createDeclarationStage(root);
const outDir = path.join(stage, "dist");
const entry = "src/ambient/consumer.ts";
requestDeclarationInputs(outDir, "ambient", [entry]);
const options = { config: false, cwd: root, entry, outDir, dts: true, clean: false,
  fixedExtension: true, logLevel: "silent", hooks: createDeclarationBoundaryHooks({
    "build:done": createDeclarationInputCapture("ambient"),
  }) };
try {
  const { bundles } = await build(options);
  for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
  const membership = readDeclarationInputs(outDir, "ambient");
  assert.ok(membership.includes("src/ambient/types/qrcode.d.ts"), "configured ambient root was omitted");
  assert.equal(membership.includes("src/ambient/unrelated.ts"), false, "unrelated source entered the compiler");
  assert.equal(fs.readdirSync(outDir).some(file => file.includes("unrelated")), false);
  const declaration = path.join(outDir, "consumer.d.mts");
  const before = fs.readFileSync(declaration, "utf8");
  assert.match(before, /data: string/);
  fs.writeFileSync(path.join(root, entry), 'export const rejected: number = "invalid";\\n');
  await assert.rejects(build(options), /Native declaration emit failed/);
  assert.equal(fs.readFileSync(declaration, "utf8"), before, "failed checking replaced declarations");
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
console.log("inherited ambient roots retained; unrelated roots excluded; selected errors rejected");
`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("TS2322");
    expect(result.stdout).toContain(
      "inherited ambient roots retained; unrelated roots excluded; selected errors rejected",
    );
  });

  it.skipIf(process.platform === "win32")(
    "admits cold sibling workspace outputs through installed aliases only in their build session",
    () => {
      const { root, write } = createFixture();
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
      const result = runFixtureModule(
        root,
        `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { build } from "tsdown";
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
const root = process.cwd();
const output = path.join(root, "packages/output-producer/dist");
const alias = ${JSON.stringify(alias)};
assert.equal(fs.existsSync(output), false, "the producer must start cold");
const originalSpawn = childProcess.spawn;
let current;
const begin = () => {
  const started = Promise.withResolvers();
  const written = Promise.withResolvers();
  current = { started, written, compilers: 0 };
  globalThis.consumerStarted = started.promise;
  globalThis.finishProducer = written.resolve;
  return current;
};
childProcess.spawn = function (command, args, options) {
  const child = originalSpawn(command, args, options);
  const project = Array.isArray(args) ? args.indexOf("-p") : -1;
  if (project >= 0 && JSON.parse(fs.readFileSync(args[project + 1], "utf8")).files?.includes(path.join(root, "src/consumer.ts"))) {
    const phase = current;
    phase.compilers++;
    phase.started.resolve();
    const emit = child.emit;
    // Delay only completion delivery, preserving the real native compilation.
    // The sibling writes between the consumer's before and after snapshots.
    child.emit = function (event, ...values) {
      if (event === "close") {
        phase.written.promise.then(() => emit.call(this, event, ...values));
        return true;
      }
      return emit.call(this, event, ...values);
    };
  }
  return child;
};
syncBuiltinESMExports();
try {
  const first = begin();
  const { bundles } = await build({ config: "tsdown.sibling.config.mts", clean: false, logLevel: "silent" });
  for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
  assert.equal(first.compilers, 1);
  for (const file of ["index.mjs", "index.d.mts"]) {
    assert.ok(fs.existsSync(path.join(alias, "dist", file)), "missing sibling " + file);
  }
  fs.rmSync(output, { recursive: true });
  const second = begin();
  const mutation = second.started.promise.then(() => {
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, "index.mjs"), "export const unrelated = 3;");
    fs.writeFileSync(path.join(output, "index.d.mts"), "export declare const unrelated: 3;");
    second.written.resolve();
  });
  await assert.rejects(build({ config: false, cwd: root, entry: "src/consumer.ts", dts: true,
    outDir: ".artifacts/consumer-output", clean: false, logLevel: "silent",
    hooks: createDeclarationBoundaryHooks() }), /resolution topology changed during compilation/);
  await mutation;
  assert.equal(second.compilers, 1);
} finally {
  current?.written.resolve();
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
console.log("cold sibling ownership and fresh build isolation verified");
`,
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("cold sibling ownership and fresh build isolation verified");
    },
  );

  it.each(
    ["node", "workspace", "AI"].flatMap((owner) => [true, false].map((dts) => ({ owner, dts }))),
  )("honors resolved dts=$dts over the opposite $owner default", ({ owner, dts }) => {
    const { root, write } = containedFixture();
    write("tsdown.ai.config.ts", fs.readFileSync("tsdown.ai.config.ts", "utf8"));
    const outside = path.join(path.dirname(root), "runtime.ts");
    fs.writeFileSync(outside, 'export const runtimeValue = "outside-runtime";');
    const result = runFixtureModule(
      root,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "tsdown";
const root = process.cwd();
const canonicalRoot = fs.realpathSync.native(root);
process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = ${JSON.stringify(dts ? "1" : "0")};
const { default: configs } = await import("./tsdown.config.ts");
const { default: ai } = await import("./tsdown.ai.config.ts");
const owner = ${JSON.stringify(owner)};
const config = owner === "AI" ? ai : configs.find(config => config.outDir ===
  (owner === "node" ? "packages/agent-core/dist" : "packages/gateway-protocol/dist"));
assert.ok(config);
assert.equal(config.dts, ${!dts});
// The build API's cwd, rather than the importing process's cwd, owns inputs.
process.chdir(path.dirname(root));
let finishedRuntime;
const runtimeDone = new Promise(resolve => { finishedRuntime = resolve; });
const { bundles } = await build({
  ...config, config: false, cwd: root, clean: false, logLevel: "silent",
  dts: ${dts ? '{ enabled: true, entry: ["src/shared.ts"], newContext: true }' : owner === "AI" ? "{ enabled: false }" : "false"}, format: ["esm", "cjs"], concurrency: 1,
  entry: ${JSON.stringify(dts ? "src/shared.ts" : outside)},
  outDir: "override-output", outExtensions: undefined, fixedExtension: true,
  inputOptions: async (input, format, context) => {
    const resolved = await config.inputOptions?.(input, format, context) ?? input;
    return { ...resolved, plugins: [resolved.plugins, {
      name: "fixture-independent-cjs",
      buildStart: { order: context.cjsDts ? "post" : "pre", async handler() {
        // CJS declarations must remain bounded after the runtime sibling finishes.
        if (context.cjsDts) await runtimeDone;
      } },
      buildEnd: { order: "post", handler() {
        if (format === "cjs" && !context.cjsDts) finishedRuntime();
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
    const { bundles: objectOptions } = await build({
      ...config, config: false, cwd: root, clean: false, logLevel: "silent",
      dts: { cwd: path.join(root, "src"), entry: ["shared.ts"] }, format: "cjs", entry: "src/shared.ts", outDir: "object-options-output",
      inputOptions: { plugins: [{ name: "fixture-object-options", buildStart() { starts++; } }] },
    });
    try {
      assert.equal(starts, 2, "object inputOptions plugin must run for runtime and declarations");
      assert.match(fs.readFileSync(path.join(root, "object-options-output/shared.d.cts"), "utf8"), /inferredOrigin: "local"/);
      assert.match(fs.readFileSync(path.join(root, "object-options-output/shared.d.cts"), "utf8"), /directoryName\\(\\): "declared-cwd"/);
    } finally {
      for (const bundle of objectOptions) await bundle[Symbol.asyncDispose]();
    }
  }
} finally {
  for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
}
console.log("resolved declaration override honored");
`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("resolved declaration override honored");
  });

  it("isolates native compilation across overlapping workspace and AI builds, including failures", () => {
    const { root, write } = containedFixture();
    write("tsdown.ai.config.ts", fs.readFileSync("tsdown.ai.config.ts", "utf8"));
    write(
      "src/second.ts",
      'import "synthetic-wrapper"; export const secondOrigin = declarationOrigin;',
    );
    const result = runFixtureModule(
      root,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
const root = process.cwd();
const canonicalRoot = fs.realpathSync.native(root);
const { default: configs } = await import("./tsdown.config.ts");
const { default: ai } = await import("./tsdown.ai.config.ts");
const workspace = configs.find(config => config.outDir === "packages/gateway-protocol/dist");
assert.ok(workspace);
process.chdir(path.dirname(root));
for (const failure of [false, true]) {
  let started = 0;
  let finishedFirst;
  const firstDone = new Promise(resolve => { finishedFirst = resolve; });
  let bothStarted;
  const barrier = new Promise(resolve => { bothStarted = resolve; });
  const launch = (config, index) => build({
    ...config, config: false, cwd: root, clean: false, logLevel: "silent",
    entry: index ? "src/second.ts" : "src/shared.ts",
    outDir: ".artifacts/lifecycle-" + index,
    plugins: [config.plugins, {
      name: "fixture-lifecycle",
      buildStart: { order: "post", async handler() {
        assert.equal(process.cwd(), path.dirname(root), "native compilation changed process cwd");
        if (++started === 2) bothStarted();
        await barrier;
        if (index) {
          await firstDone;
          if (failure) throw new Error("fixture buildStart failure");
        }
      } },
    }],
  });
  const results = await Promise.allSettled([
    launch(workspace, 0).finally(() => finishedFirst()),
    launch(ai, 1),
  ]);
  assert.equal(results[0].status, "fulfilled", results[0].reason?.stack);
  assert.equal(results[1].status, failure ? "rejected" : "fulfilled", results[1].reason?.stack);
  assert.equal(fs.readdirSync(path.join(root, ".artifacts")).some(name => name.startsWith("native-declarations-")), false, "native stage leaked after settled builds");
  if (!failure) {
    assert.match(fs.readFileSync(path.join(root, ".artifacts/lifecycle-1/second.d.mts"), "utf8"), /secondOrigin: "local"/);
  }
}
console.log("workspace/AI native compilation settled after success and failure");
`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "workspace/AI native compilation settled after success and failure",
    );
  });

  it.each([
    {
      name: "SDK",
      groups: TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
      run: (root: string, env = {}) => runWriter(root, false, env),
    },
    { name: "unified", groups: TSDOWN_NON_SDK_DTS_CONFIG_GROUPS, run: runUnifiedWriter },
  ])("uses local explicit references and seals real inputs for $name", ({ groups, run }) => {
    const { root, write, localInput } = containedFixture(groups);
    const unconsumedInput = path.join(root, "test/unrelated.test.ts");
    write(
      "tsdown.config.ts",
      `${fs.readFileSync(path.join(root, "tsdown.config.ts"), "utf8")}
for (const config of configs) {
  if (!config.dts?.emitDtsOnly) continue;
  const register = config.hooks;
  config.hooks = async hooks => {
    await register(hooks);
    hooks.hook("build:done", () => {
      const marker = ".artifacts/replace-input";
      if (!fs.existsSync(marker)) return;
      const file = fs.readFileSync(marker, "utf8") === "unconsumed" ? ${JSON.stringify(unconsumedInput)} : ${JSON.stringify(localInput)};
      fs.writeFileSync(file + ".replacement", fs.readFileSync(file));
      fs.renameSync(file + ".replacement", file);
    });
  };
}
`,
    );
    const initial = run(root);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    const published = treeHashes(path.join(root, "dist"));
    const declarations = Object.keys(published)
      .filter((file) => file.endsWith(".d.ts"))
      .map((file) => fs.readFileSync(path.join(root, "dist", file), "utf8"))
      .join("\n");
    expect(declarations.match(/declare const inferredOrigin: [^;]+;/u)?.[0]).toBe(
      'declare const inferredOrigin: "local";',
    );
    const inputs = declarationCacheRecords(root).flatMap((record) => record.inputs ?? []);
    expect(inputs).toContain(localInput);
    for (const input of inputs) {
      const relative = path.relative(root, fs.realpathSync(path.resolve(root, input)));
      expect(
        relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
        input,
      ).toBe(false);
    }
    expectStagingClean(root);
    // Both writers seal through the same owner. Replay its mutation cycle once;
    // the unified suite separately covers failed and mixed-cache publication.
    if (groups === TSDOWN_NON_SDK_DTS_CONFIG_GROUPS) {
      return;
    }
    const cached = treeHashes(path.join(root, ".artifacts/build-all-cache"));
    write(".artifacts/replace-input", "unconsumed");
    const unconsumedChanged = run(root, { OPENCLAW_BUILD_CACHE: "0" });
    expect(unconsumedChanged.status, unconsumedChanged.stdout + unconsumedChanged.stderr).toBe(0);
    expect(treeHashes(path.join(root, "dist"))).toEqual(published);
    const restored = run(root);
    expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    expect(restored.stdout + restored.stderr).not.toContain("[tsdown-build] invocation");
    write(".artifacts/replace-input", "local");
    const localChanged = run(root, { OPENCLAW_BUILD_CACHE: "0" });
    expect(localChanged.status, localChanged.stdout + localChanged.stderr).toBeGreaterThan(0);
    expect(localChanged.stdout + localChanged.stderr).toContain("changed during compilation");
    expect(treeHashes(path.join(root, "dist"))).toEqual(published);
    expect(treeHashes(path.join(root, ".artifacts/build-all-cache"))).toEqual(cached);
    expectStagingClean(root);
  });

  it.each([
    "ancestor module",
    "ancestor package alias",
    "ancestor ambient types",
    "package symlink",
    "source symlink",
    "source reference",
    "ancestor symlink reference",
  ])("refuses an escaped %s before publication", (kind) => {
    const ancestorLookup = [
      "ancestor module",
      "ancestor package alias",
      "ancestor ambient types",
    ].includes(kind);
    const { root, write, ancestorInput, localInput } = ancestorLookup
      ? nestedFixture()
      : containedFixture();
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
      if (kind === "ancestor symlink reference") {
        fs.rmSync(path.join(outside, "index.d.ts"));
        fs.symlinkSync(path.join(root, "src/contract.d.ts"), path.join(outside, "index.d.ts"));
      }
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
    const failed = runWriter(root);
    expect(failed.status, failed.stdout + failed.stderr).toBeGreaterThan(0);
    expect(failed.stdout + failed.stderr).toContain("Declaration input escapes checkout");
    expect(failed.stdout + failed.stderr).toContain(rejectedPath);
    expect(treeHashes(path.join(root, "dist"))).toEqual(before);
    expectStagingClean(root);
  });
});
