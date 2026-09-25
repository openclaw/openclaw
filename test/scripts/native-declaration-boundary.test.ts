import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { portableRelativePath } from "../../scripts/lib/build-artifact-cache.mts";
import { BoundaryInputSnapshot } from "../../scripts/lib/extension-boundary-inputs.mts";
import { createDeclarationInputBoundary } from "../../scripts/lib/local-check-runtime.mts";
import { emitNativeDeclarations } from "../../scripts/lib/native-declaration-emitter.mts";
import { readNativeTypeScriptConfig } from "../../scripts/lib/native-typescript-config.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  installNativeAncestorTypes,
  materializeNativeCompiler,
  resolveNativeFixtureShortPath,
  writeNativeFixtureFile,
} from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("keeps test-only ambient augmentation out of declaration roots but in test graphs", () => {
  const root = fs.realpathSync.native(roots.make("native-declaration-production-roots-"));
  // Use the actual production/test selection rules with a tiny semantic-free fixture.
  const testConfigs = [
    "test/tsconfig/tsconfig.test.json",
    "src/tsconfig.json",
    "ui/tsconfig.json",
    "extensions/tsconfig.json",
  ];
  // Actual emit owners: tsgo:prod UI/plugin configs are noEmit typecheck graphs.
  const productionConfigs = [
    "tsconfig.json",
    "packages/plugin-sdk/tsconfig.json",
    "extensions/browser/tsconfig.json",
  ];
  for (const config of [
    ...productionConfigs,
    ...testConfigs,
    "extensions/tsconfig.package-boundary.paths.json",
    "extensions/tsconfig.package-boundary.base.json",
  ]) {
    writeNativeFixtureFile(root, config, fs.readFileSync(config, "utf8"));
  }
  const productionAmbient = "src/types/production.d.ts";
  const testAmbient = "src/config/sessions/session-entry.test-compat.d.ts";
  writeNativeFixtureFile(root, productionAmbient, "declare const productionOrigin: string;");
  writeNativeFixtureFile(root, testAmbient, 'import "./runtime.js";');
  writeNativeFixtureFile(root, "src/config/sessions/runtime.ts", "export const value = 1;");
  for (const file of [
    "packages/example/src/index.ts",
    "src/plugin-sdk/index.ts",
    "extensions/browser/src/index.ts",
  ]) {
    writeNativeFixtureFile(root, file, "export const value = 1;");
  }
  const configuredRoots = (configFileName: string) =>
    readNativeTypeScriptConfig({ cwd: root, configFileName }).fileNames.map((file) =>
      path.relative(root, file).replaceAll(path.sep, "/"),
    );
  const production = configuredRoots("tsconfig.json");
  expect(production).toContain(productionAmbient);
  for (const config of productionConfigs) {
    expect(configuredRoots(config), config).not.toContain(testAmbient);
  }
  for (const config of testConfigs) {
    expect(configuredRoots(config), config).toContain(testAmbient);
  }
});

it.each([true, false])(
  "diagnoses declaration escapes with an ancestor install=%s",
  (ancestorInstall) => {
    const ancestor = fs.realpathSync.native(roots.make("declaration-escape-diagnosis-"));
    const root = path.join(ancestor, ".claude/worktrees/validation");
    fs.mkdirSync(root, { recursive: true });
    const install = path.join(ancestor, ancestorInstall ? "node_modules" : "other/node_modules");
    const file = path.join(install, "synthetic-package/package.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    const boundary = createDeclarationInputBoundary(root);
    expect(() => boundary.assert(file)).toThrow(`Declaration input escapes checkout: ${file}`);
    if (ancestorInstall) {
      expect(() => boundary.assert(file)).toThrow(`another install at ${install}`);
      expect(() => boundary.assert(file)).toThrow("separate physical checkout");
      expect(() => boundary.assert(file)).toThrow("Repeating pnpm install will not isolate");
    } else {
      expect(() => boundary.assert(file)).toThrow(
        "shared installs and external symlinks are unsupported",
      );
      expect(() => boundary.assert(file)).toThrow(
        "does not establish a missing or undeclared dependency",
      );
    }
  },
);

function createNativeFixture(root: string, declared = root) {
  fs.mkdirSync(root, { recursive: true });
  const native = materializeNativeCompiler(declared);
  const write = (file: string, text: string) => writeNativeFixtureFile(root, file, text);
  write("package.json", '{"type":"module"}');
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2023",
        types: [],
        skipLibCheck: true,
        rootDir: "src",
        declaration: true,
        incremental: true,
      },
      files: ["src/index.ts"],
    }),
  );
  write(
    "src/index.ts",
    'import type { Marker } from "synthetic-wrapper";\nexport type { Marker };\nexport const inferredOrigin = declarationOrigin;\n',
  );
  const compile = (noEmit = false, extraArgs: string[] = []) => {
    const config = path.join(declared, "tsconfig.json");
    const buildInfo = "dist/.tsbuildinfo";
    const outputRoot = noEmit ? undefined : path.join(root, "dist");
    const args = [
      "-p",
      config,
      noEmit ? "--noEmit" : "--emitDeclarationOnly",
      "--outDir",
      path.join(declared, "dist"),
      "--tsBuildInfoFile",
      path.join(declared, buildInfo),
      "--listEmittedFiles",
      ...extraArgs,
    ];
    const before = new BoundaryInputSnapshot(declared);
    before.signature(config, args, [], outputRoot);
    fs.rmSync(path.join(root, buildInfo), { force: true });
    const startedAt = Date.now();
    const compiled = spawnSync(native, args, {
      cwd: declared,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const outputs = compiled.stdout
      .split("\n")
      .filter((line) => line.startsWith("TSFILE: "))
      .map((line) => portableRelativePath(root, fs.realpathSync.native(line.slice(8).trim())));
    const info: { fileNames: string[]; fileInfos: unknown[]; packageJsons?: string[] } = JSON.parse(
      fs.readFileSync(path.join(root, buildInfo), "utf8"),
    );
    const record = () =>
      new BoundaryInputSnapshot(declared).record(
        config,
        args,
        buildInfo,
        outputs,
        before,
        startedAt,
        outputRoot,
      );
    return { config, args, buildInfo, outputs, info, outputRoot, record, trace: compiled.stdout };
  };
  return { native, write, compile };
}

it.each([false, true])(
  "rejects successful native ancestor membership before acceptance (noEmit=%s)",
  (noEmit) => {
    const ancestor = fs.realpathSync.native(roots.make("native-declaration-ancestor-"));
    const root = path.join(ancestor, ".claude/worktrees/validation");
    const f = createNativeFixture(root);
    installNativeAncestorTypes(ancestor, root);
    const run = f.compile(noEmit);
    expect(
      run.info.fileNames.some((name) =>
        name.includes("../../../node_modules/@types/synthetic-core"),
      ),
    ).toBe(true);
    if (!noEmit) {
      expect(fs.readFileSync(path.join(root, "dist/index.d.ts"), "utf8")).toContain(
        'inferredOrigin: "ancestor"',
      );
    }
    // The successful native receipt is evidence of contamination, never an accepted generation.
    expect(run.record).toThrow(/Declaration input escapes checkout/);
  },
);

it("diagnoses manifest-only ancestor probes and seals the same local inputs in a standalone checkout", () => {
  const ancestor = fs.realpathSync.native(roots.make("native-manifest-probe-"));
  const nested = path.join(ancestor, ".claude/worktrees/validation");
  const standalone = fs.realpathSync.native(roots.make("native-manifest-isolated-"));
  const manifest = JSON.stringify({ name: "synthetic-js", version: "1.0.0", main: "index.js" });
  writeNativeFixtureFile(ancestor, "node_modules/synthetic-js/package.json", manifest);
  writeNativeFixtureFile(
    ancestor,
    "node_modules/synthetic-js/index.js",
    "exports.origin = 'ancestor';\n",
  );
  for (const root of [nested, standalone]) {
    const f = createNativeFixture(root);
    f.write("src/index.ts", 'export type { Value } from "synthetic-wrapper";\n');
    f.write("node_modules/synthetic-wrapper/package.json", '{"types":"index.d.ts"}');
    f.write(
      "node_modules/synthetic-wrapper/index.d.ts",
      'export type Value = typeof import("synthetic-js");\n',
    );
    f.write("node_modules/synthetic-js/package.json", manifest);
    f.write("node_modules/synthetic-js/index.js", "exports.origin = 'local';\n");
    const run = f.compile(false, ["--traceResolution"]);
    const directory = path.join(root, "dist");
    const sourceFiles = run.info.fileNames.slice(0, run.info.fileInfos.length);
    const externalManifest = path.join(ancestor, "node_modules/synthetic-js/package.json");
    expect(
      sourceFiles.some((file) =>
        path.relative(root, path.resolve(directory, file)).startsWith(`..${path.sep}`),
      ),
    ).toBe(false);
    expect(run.trace.replaceAll("\\", "/")).toContain(
      `'synthetic-js' was successfully resolved to '${root.replaceAll("\\", "/")}/node_modules/synthetic-js/index.js'`,
    );
    if (root === nested) {
      // Declaration lookup visits outer manifests before falling back to local JavaScript.
      expect(run.info.packageJsons?.map((file) => path.resolve(directory, file))).toContain(
        externalManifest,
      );
      expect(run.record).toThrow("complete local install");
      expect(run.record).toThrow("Repeating pnpm install will not isolate");
      continue;
    }
    const record = run.record();
    expect(record.inputs).toContain("node_modules/synthetic-js/package.json");
    expect(record.inputs?.some((file) => file.startsWith("../"))).toBe(false);
    const warm = new BoundaryInputSnapshot(root);
    expect(warm.matches(record, run.config, run.args, run.outputs, run.outputRoot)).toBe(true);
    f.write("node_modules/synthetic-js/package.json", `${manifest}\n`);
    expect(
      new BoundaryInputSnapshot(root).matches(
        record,
        run.config,
        run.args,
        run.outputs,
        run.outputRoot,
      ),
    ).toBe(false);
  }
});

for (const kind of [
  "directory alias",
  "Windows 8.3 alias",
  "directory alias targeting Windows 8.3",
  "Windows namespaced executable",
]) {
  it.skipIf(kind.includes("Windows") && process.platform !== "win32")(
    `emits, records every native input, and stays warm through a ${kind}`,
    (context) => {
      const ancestor = fs.realpathSync.native(roots.make("native-declaration-alias-"));
      const longExecutable = kind === "Windows namespaced executable";
      const directory = longExecutable ? "LongNativeCheckout".repeat(10) : "validation";
      const root = path.join(ancestor, ".claude/worktrees", directory);
      fs.mkdirSync(root, { recursive: true });
      let target = root;
      if (kind.includes("8.3")) {
        const short = resolveNativeFixtureShortPath(root);
        if (!short) {
          context.skip("Filesystem does not expose a distinct Windows 8.3 checkout alias");
          return;
        }
        target = short;
      }
      let declared = target;
      if (kind.startsWith("directory alias") || longExecutable) {
        declared = path.join(path.dirname(root), "declared-alias");
        fs.symlinkSync(target, declared, "junction");
      }
      if (kind === "directory alias targeting Windows 8.3") {
        expect(fs.realpathSync(declared)).not.toBe(declared);
        expect(fs.realpathSync(declared)).not.toBe(root);
      }
      const f = createNativeFixture(root, declared);
      if (longExecutable) {
        // Exercise the actual installed getExePath contract, not a synthetic path adapter.
        expect(f.native.startsWith("\\\\?\\")).toBe(true);
        expect(f.native.slice(4).length).toBeGreaterThanOrEqual(248);
      }
      installNativeAncestorTypes(ancestor, root);
      fs.rmSync(path.join(ancestor, "node_modules"), { recursive: true });
      const run = f.compile();
      expect(fs.readFileSync(path.join(root, "dist/index.d.ts"), "utf8")).toContain(
        'inferredOrigin: "local"',
      );
      const record = run.record();
      const receiptDirectory = path.dirname(path.join(declared, run.buildInfo));
      // Native's receipt lists source membership, compact bundled libraries, and
      // package manifests. Admission must retain the entire successful inventory.
      const sourceInputs = run.info.fileNames
        .slice(0, run.info.fileInfos.length)
        .map((file) =>
          path.resolve(
            file.startsWith("lib.") && !file.includes("/")
              ? path.dirname(f.native)
              : receiptDirectory,
            file,
          ),
        );
      const packageInputs = (run.info.packageJsons ?? []).map((file) =>
        path.resolve(receiptDirectory, file),
      );
      const nativeInputs = [...sourceInputs, ...packageInputs].map((file) =>
        portableRelativePath(root, fileURLToPath(pathToFileURL(fs.realpathSync.native(file)))),
      );
      expect(record.inputs).toEqual([...new Set(nativeInputs)].toSorted());
      expect(record.inputs).toContain("src/index.ts");
      expect(record.inputs).toContain(
        "node_modules/.pnpm/core/node_modules/@types/synthetic-core/index.d.ts",
      );
      expect(record.inputs?.some((file) => file.endsWith("/lib.es2023.d.ts"))).toBe(true);
      const warm = new BoundaryInputSnapshot(declared);
      expect(warm.matches(record, run.config, run.args, run.outputs, run.outputRoot)).toBe(true);
      const sourceHash = warm.hash(path.join(root, "src/index.ts"));
      for (const spelling of [declared, fs.realpathSync(declared), root]) {
        expect(warm.hash(path.join(spelling, "src/index.ts")), spelling).toBe(sourceHash);
      }
    },
  );
}

it("rejects a real native reference through an unrelated outside symlink back inside", () => {
  const ancestor = fs.realpathSync.native(roots.make("native-declaration-symlink-back-"));
  const root = path.join(ancestor, ".claude/worktrees/validation");
  const f = createNativeFixture(root);
  const outside = path.join(ancestor, "outside-reference");
  fs.symlinkSync(path.join(root, "src"), outside, "junction");
  f.write("src/referenced.d.ts", 'interface FixtureContract { origin: "local" }\n');
  const reference = path.join(outside, "referenced.d.ts");
  f.write(
    "src/index.ts",
    `/// <reference path="${reference.replaceAll(path.sep, "/")}" />\nexport type Marker = FixtureContract;\n`,
  );
  const run = f.compile();
  expect(fs.realpathSync.native(reference)).toBe(path.join(root, "src/referenced.d.ts"));
  expect(
    run.info.fileNames.some(
      (file) => path.relative(reference, path.resolve(root, "dist", file)) === "",
    ),
  ).toBe(true);
  expect(run.record).toThrow(/Declaration input escapes checkout/);
});

it("preserves original nested config paths and explicit override precedence during native emission", async () => {
  const root = fs.realpathSync.native(roots.make("native-declaration-config-context-"));
  const fixture = createNativeFixture(root);
  const widget = "packages/widget";
  const entry = path.join(root, widget, "src/entry.ts");
  const configFile = path.join(root, widget, "tsconfig.json");
  const boundary = createDeclarationInputBoundary(root);
  const commonOptions = {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2023",
    strict: true,
    skipLibCheck: true,
    types: ["*"],
  };
  const configure = (compilerOptions: Record<string, unknown> = {}) =>
    fixture.write(
      "config/widget-base.json",
      JSON.stringify({ compilerOptions: { ...commonOptions, ...compilerOptions } }),
    );
  const emit = (compilerOptions?: Record<string, unknown>) =>
    emitNativeDeclarations({
      cwd: root,
      compilerRoot: root,
      configFile,
      roots: [entry],
      compilerOptions,
      assertInput: (file) => boundary.assert(file),
    });
  fixture.write(`${widget}/package.json`, '{"type":"module"}');
  fixture.write(
    `${widget}/tsconfig.json`,
    JSON.stringify({
      extends: "../../config/widget-base.json",
      files: ["src/entry.ts"],
      include: [],
    }),
  );
  fixture.write(
    `${widget}/node_modules/@types/widget-local/index.d.ts`,
    'declare const widgetTypeOrigin: "widget-local";\n',
  );
  fixture.write(
    "node_modules/@types/root-fallback/index.d.ts",
    'declare const rootTypeOrigin: "root-fallback";\n',
  );
  configure();
  fixture.write(
    `${widget}/src/entry.ts`,
    "export const local = widgetTypeOrigin;\nexport const fallback = rootTypeOrigin;\n",
  );
  const implicit = await emit();
  expect(implicit.declarations.get(entry)?.code).toContain('local: "widget-local"');
  expect(implicit.declarations.get(entry)?.code).toContain('fallback: "root-fallback"');
  expect(implicit.inputs).toEqual(
    expect.arrayContaining([
      path.join(root, widget, "node_modules/@types/widget-local/index.d.ts"),
      path.join(root, "node_modules/@types/root-fallback/index.d.ts"),
    ]),
  );

  const inheritedOptions = {
    typeRoots: ["${configDir}/custom-types"],
    paths: { "#contract": ["${configDir}/contracts/inherited.ts"] },
    rootDirs: ["${configDir}/src", "${configDir}/generated"],
  };
  configure(inheritedOptions);
  fixture.write(
    `${widget}/custom-types/marker/index.d.ts`,
    'declare const configuredTypeOrigin: "config-dir";\n',
  );
  fixture.write(`${widget}/contracts/inherited.ts`, 'export const contract = "inherited";\n');
  fixture.write(`${widget}/generated/peer.ts`, 'export const peer = "root-dir";\n');
  fixture.write(
    `${widget}/src/entry.ts`,
    'import { contract } from "#contract";\nimport { peer } from "./peer.js";\nexport const resolvedContract = contract;\nexport const resolvedPeer = peer;\nexport const configuredType = configuredTypeOrigin;\n',
  );
  const inherited = await emit();
  expect(inherited.declarations.get(entry)?.code).toMatch(
    /resolvedContract\s*(?::|=)\s*"inherited"/u,
  );
  expect(inherited.declarations.get(entry)?.code).toMatch(/resolvedPeer\s*(?::|=)\s*"root-dir"/u);
  expect(inherited.declarations.get(entry)?.code).toContain('configuredType: "config-dir"');
  expect(inherited.inputs).toEqual(
    expect.arrayContaining([
      path.join(root, widget, "custom-types/marker/index.d.ts"),
      path.join(root, widget, "contracts/inherited.ts"),
      path.join(root, widget, "generated/peer.ts"),
    ]),
  );
  expect(inherited.inputs).not.toContain(
    path.join(root, widget, "node_modules/@types/widget-local/index.d.ts"),
  );

  fixture.write(
    `${widget}/override-types/marker/index.d.ts`,
    'declare const configuredTypeOrigin: "override-type";\n',
  );
  fixture.write(`${widget}/contracts/override.ts`, 'export const contract = "override";\n');
  fixture.write(`${widget}/override-generated/peer.ts`, 'export const peer = "override-root";\n');
  const rawOverrides = {
    typeRoots: ["./override-types"],
    paths: { "#contract": ["./contracts/override.ts"] },
    rootDirs: ["./src", "./override-generated"],
  };
  const overridden = await emit(rawOverrides);
  expect(overridden.declarations.get(entry)?.code).toMatch(
    /resolvedContract\s*(?::|=)\s*"override"/u,
  );
  expect(overridden.declarations.get(entry)?.code).toMatch(
    /resolvedPeer\s*(?::|=)\s*"override-root"/u,
  );
  expect(overridden.declarations.get(entry)?.code).toContain('configuredType: "override-type"');
  expect(overridden.inputs).toEqual(
    expect.arrayContaining([
      path.join(root, widget, "override-types/marker/index.d.ts"),
      path.join(root, widget, "contracts/override.ts"),
      path.join(root, widget, "override-generated/peer.ts"),
    ]),
  );
  expect(overridden.inputs).not.toContain(path.join(root, widget, "contracts/inherited.ts"));

  // This name exists in an implicit local root, so an accidental fallback would pass.
  fixture.write(`${widget}/src/entry.ts`, "export const mustBeMissing = widgetTypeOrigin;\n");
  await expect(emit({ ...rawOverrides, typeRoots: [] })).rejects.toThrow(
    "Native declaration emit failed",
  );
  configure({ ...inheritedOptions, typeRoots: [] });
  await expect(emit()).rejects.toThrow("Native declaration emit failed");
  expect(fs.readdirSync(path.join(root, ".artifacts"))).toEqual([]);
});

it("rejects config paths changed after materialization while preserving default-glob emission", async () => {
  const root = fs.realpathSync.native(roots.make("native-declaration-config-mutation-"));
  const fixture = createNativeFixture(root);
  const entry = path.join(root, "src/index.ts");
  const configFile = path.join(root, "tsconfig.json");
  const artifacts = path.join(root, ".artifacts");
  const boundary = createDeclarationInputBoundary(root);
  const configuration = (origin: string) =>
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2023",
        types: [],
        paths: { "#contract": [`./contracts/${origin}.ts`] },
      },
    });
  fixture.write("tsconfig.json", configuration("before"));
  fixture.write("contracts/before.ts", 'export const origin = "before";\n');
  fixture.write("contracts/after.ts", 'export const origin = "after";\n');
  fixture.write(
    "src/index.ts",
    'import { origin } from "#contract";\nexport const resolvedOrigin = origin;\n',
  );
  const emit = () =>
    emitNativeDeclarations({
      cwd: root,
      compilerRoot: root,
      configFile,
      roots: [entry],
      assertInput: (file) => boundary.assert(file),
    });

  // No files/include/exclude: the original default glob must not admit its private output.
  const stable = await emit();
  expect(stable.declarations.get(entry)?.code).toMatch(/resolvedOrigin\s*(?::|=)\s*"before"/u);
  expect(stable.inputs).not.toContain(path.join(root, "contracts/after.ts"));
  expect(fs.readdirSync(artifacts)).toEqual([]);

  let changed = false;
  const write = fs.writeFileSync.bind(fs);
  const writer = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    write(...args);
    const file = args[0];
    if (
      !changed &&
      typeof file === "string" &&
      path.basename(file) === "tsconfig.json" &&
      path.basename(path.dirname(file)).startsWith("native-declarations-") &&
      path.dirname(path.dirname(file)) === artifacts
    ) {
      changed = true;
      write(configFile, configuration("after"));
    }
  });
  try {
    await expect(emit()).rejects.toThrow(/Boundary .*changed during compilation/u);
  } finally {
    writer.mockRestore();
  }
  expect(changed).toBe(true);
  expect(fs.readFileSync(configFile, "utf8")).toBe(configuration("after"));
  expect(fs.readdirSync(artifacts)).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "rejects a split native resolution trace before exposing declarations",
  async () => {
    const parent = fs.realpathSync.native(roots.make("native-declaration-trace-framing-"));
    // Windows does not permit control characters in file names.
    const root = path.join(parent, "split\nname");
    const fixture = createNativeFixture(root);
    fixture.write("src/index.ts", 'export type { Marker } from "./contract.js";\n');
    fixture.write("src/contract.ts", "export interface Marker { value: 1 }\n");
    const boundary = createDeclarationInputBoundary(root);
    await expect(
      emitNativeDeclarations({
        cwd: root,
        compilerRoot: root,
        configFile: path.join(root, "tsconfig.json"),
        roots: [path.join(root, "src/index.ts")],
        assertInput: (file) => boundary.assert(file),
      }),
    ).rejects.toThrow("Unrecognized native declaration resolution trace");
    expect(fs.readdirSync(path.join(root, ".artifacts"))).toEqual([]);
  },
);
