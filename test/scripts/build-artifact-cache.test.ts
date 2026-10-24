import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_CACHE_VERSION,
  acquireBuildArtifactLock,
  portableRelativePath,
  readArtifactRecord,
  writeArtifactRecord,
  type ArtifactRecord,
} from "../../scripts/lib/build-artifact-cache.mts";
import { CompilerInputSnapshot } from "../../scripts/lib/compiler-input-snapshot.mts";
import { BoundaryInputSnapshot } from "../../scripts/lib/extension-boundary-inputs.mts";
import { createDeclarationInputBoundary } from "../../scripts/lib/local-check-runtime.mts";
import { nativeTypeScriptToolchainFiles } from "../../scripts/lib/native-typescript-toolchain.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { materializeNativeCompiler } from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const compileWorker = path.resolve("scripts/compile-extension-boundary.mts");
const valueConsumer = (module: string) =>
  `import { value } from "${module}"; const expected: 1 = value;`;

function compilerSnapshot(root: string) {
  const boundary = createDeclarationInputBoundary(root);
  const assertInput = (file: string) => boundary.assert(file);
  const require = createRequire(path.join(boundary.root, "package.json"));
  const nativePackage = assertInput(require.resolve("typescript/package.json"));
  return new CompilerInputSnapshot(boundary.root, {
    toolchainFiles: nativeTypeScriptToolchainFiles(nativePackage, assertInput),
    generatorInputs: ["package.json", "pnpm-lock.yaml"],
    assertInput,
  });
}

function fixture(
  noEmit = false,
  outputRoot = "dist",
  tempRoots = roots,
  owner: "boundary" | "compiler" = "boundary",
) {
  const root = fs.realpathSync.native(tempRoots.make("native-boundary-cache-"));
  const resolve = (relative: string) => path.join(root, relative);
  materializeNativeCompiler(root);
  const write = (file: string, bytes: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    fs.utimesSync(target, new Date(1000), new Date(1000));
  };
  const writeJson = (file: string, value: unknown) => write(file, JSON.stringify(value));
  writeJson("base.json", {
    compilerOptions: {
      target: "es2023",
      module: "nodenext",
      allowJs: true,
      declaration: true,
      outDir: outputRoot,
      rootDir: ".",
      skipLibCheck: true,
      types: [],
    },
  });
  writeJson("tsconfig.json", {
    extends: "./base.json",
    include: ["src/*.ts"],
    exclude: ["**/*.test.ts"],
  });
  write("package.json", '{"type":"module"}');
  write("pnpm-lock.yaml", "lock");
  write("src/api.ts", 'export { value } from "../nested/value.js";');
  write("nested/value.js", "export const value = 1;");
  write("unrelated/source.ts", "export const unrelated = 1;");
  write("src/api.test.ts", "export const test = 1;");
  const config = "tsconfig.json";
  const inputReceipt = `${outputRoot}/.inputs.json`;
  const compilerArgs = (configFile: string, receipt: string, emit = false) => [
    compileWorker,
    JSON.stringify({
      configFile,
      inputReceipt: receipt,
      compilerOptions: { outDir: outputRoot, rootDir: ".", declarationMap: false },
      emit,
    }),
  ];
  const args = compilerArgs(config, inputReceipt, !noEmit);
  const ownedOutputRoot = noEmit ? undefined : path.join(root, outputRoot);
  const compile = (command = args, status = 0) => {
    const result = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return result;
  };
  const prepare = () => {
    fs.mkdirSync(resolve(outputRoot), { recursive: true });
    fs.rmSync(resolve(inputReceipt), { force: true });
    return compile()
      .stdout.split("\n")
      .filter((line) => line.startsWith("TSFILE: "))
      .map((line) => portableRelativePath(root, line.slice(8).trim()))
      .toSorted();
  };
  const seal = (run: ReturnType<typeof prepare>) => {
    if (owner === "compiler") {
      const snapshot = compilerSnapshot(root);
      const { inputs }: { inputs: string[] } = JSON.parse(
        fs.readFileSync(resolve(inputReceipt), "utf8"),
      );
      return {
        version: ARTIFACT_CACHE_VERSION,
        signature: snapshot.signature(config, args, inputs, ownedOutputRoot),
        inputs,
        outputs: Object.fromEntries(run.map((file) => [file, snapshot.hash(file)])),
      };
    }
    return new BoundaryInputSnapshot(root).record(config, args, inputReceipt, run, ownedOutputRoot);
  };
  const matches = (
    record: ArtifactRecord | undefined,
    at = root,
    outputs = Object.keys(record?.outputs ?? {}),
    output = ownedOutputRoot,
  ) =>
    owner === "compiler"
      ? compilerSnapshot(at).matches(record, config, args, outputs, output)
      : new BoundaryInputSnapshot(at).matchesReceipt(
          record,
          config,
          args,
          outputs,
          inputReceipt,
          output,
        );
  return {
    root,
    file: resolve,
    write,
    config,
    args,
    compilerArgs,
    inputReceipt,
    compile,
    prepare,
    seal,
    matches,
  };
}

describe("native owner content records", () => {
  it("invalidates a linked declaration consumer when a source shadows its emitted types", () => {
    const f = fixture(false, "packages/sdk/dist");
    f.write("packages/sdk/package.json", '{"name":"fixture-sdk","type":"module"}');
    f.write("consumer.json", '{"extends":"./base.json","files":["consumer.ts"]}');
    f.write("consumer.ts", valueConsumer("fixture-sdk/dist/nested/value.js"));
    fs.symlinkSync("../packages/sdk", f.file("node_modules/fixture-sdk"), "dir");
    f.prepare();
    const config = "consumer.json";
    const metadata = ".artifacts/consumer.inputs.json";
    const args = f.compilerArgs(config, metadata);
    f.compile(args);
    const record = new BoundaryInputSnapshot(f.root).record(config, args, metadata, [metadata]);
    const matches = () =>
      new BoundaryInputSnapshot(f.root).matchesReceipt(record, config, args, [metadata], metadata);
    expect(matches()).toBe(true);
    f.write("packages/sdk/dist/nested/value.ts", 'export const value = "changed";');
    expect(matches()).toBe(false);
    expect(f.compile(args, 1).stderr).toContain("TS2322");
  });

  it("invalidates new resolution candidates behind checkout-local linked node_modules directories", () => {
    const f = fixture(true);
    const dependency = f.file("fixture-dependencies");
    fs.renameSync(f.file("node_modules"), dependency);
    const packageRoot = path.join(dependency, "fixture-package");
    const moduleRoot = path.join(packageRoot, "dist");
    fs.mkdirSync(moduleRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(moduleRoot, "value.d.ts"), "export declare const value: 1;");
    fs.writeFileSync(path.join(packageRoot, "unrelated.ts"), "export const unrelated = 1;");
    fs.symlinkSync(dependency, f.file("node_modules"), "dir");
    // Repeated aliases and a back-edge must not expand the same subtree indefinitely.
    fs.symlinkSync(packageRoot, path.join(packageRoot, "self"), "dir");
    fs.symlinkSync(f.root, path.join(packageRoot, "consumer"), "dir");
    fs.symlinkSync(packageRoot, f.file("alias"), "dir");
    f.write("src/api.ts", valueConsumer("fixture-package/dist/value.js"));
    const record = f.seal(f.prepare());
    expect(record.inputs?.some((file) => file.endsWith("/value.d.ts"))).toBe(true);
    const matches = () => f.matches(record);
    expect(matches()).toBe(true);
    fs.writeFileSync(path.join(packageRoot, "unrelated.ts"), "export const unrelated = 2;");
    f.write(".artifacts/ignored.ts", "export {};");
    f.write("dist/ignored.d.ts", "export {};");
    expect(matches()).toBe(true);
    fs.writeFileSync(path.join(moduleRoot, "value.ts"), 'export const value = "changed";');
    const staleHit = matches();
    const result = f.compile(f.args, 1);
    expect(result.stderr).toContain("TS2322");
    expect(result.stderr).toContain("Type '\"changed\"' is not assignable to type '1'");
    expect(staleHit).toBe(false);
  });

  it("tracks dangling link directory existence and link identity", () => {
    const f = fixture(true, "dist", roots, "compiler");
    const dependency = f.file("fixture-dependencies");
    fs.mkdirSync(dependency);
    const target = path.join(dependency, "missing");
    const link = f.file("missing");
    fs.symlinkSync(target, link, "dir");
    const record = f.seal(f.prepare());
    expect(f.matches(record)).toBe(true);
    fs.mkdirSync(target);
    expect(f.matches(record)).toBe(false);
    fs.rmSync(target, { recursive: true });
    expect(f.matches(record)).toBe(true);
    fs.unlinkSync(link);
    fs.symlinkSync(`${target}-other`, link, "dir");
    expect(f.matches(record)).toBe(false);
  });

  it("ignores tool scratch churn under installed roots", () => {
    const f = fixture(true, "dist", roots, "compiler");
    const run = f.prepare();
    // Sibling config loads mint these between the before and seal walks.
    f.write("node_modules/.vite-temp/vitest.config.ts.timestamp-1-a.mjs", "export default {};");
    const record = f.seal(run);
    expect(f.matches(record)).toBe(true);
    fs.rmSync(f.file("node_modules/.vite-temp"), { recursive: true });
    f.write("node_modules/.cache/jiti/config.deadbeef.mjs", "export default {};");
    expect(f.matches(record)).toBe(true);
    f.write("node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js", "export const value = 1;");
    expect(f.matches(record)).toBe(false);
  });

  it("keeps a compiled generation warm across native app scratch creation and removal", () => {
    const f = fixture(false, "dist", roots, "compiler");
    const record = f.seal(f.prepare());
    const matches = () => f.matches(record);
    expect(matches()).toBe(true);
    f.write("apps/macos/.build/arm64/release/description.json", "{}");
    f.write("apps/macos/.build/arm64/checkouts/library/package.json", "{}");
    expect(matches()).toBe(true);
    fs.rmSync(f.file("apps/macos/.build"), { recursive: true });
    expect(matches()).toBe(true);
    f.write("nested/value.ts", "export const value = 2;");
    expect(matches()).toBe(false);
  });

  it("propagates non-ENOENT link resolution errors", () => {
    const f = fixture(true);
    fs.symlinkSync("loop", f.file("loop"));
    expect(() => new BoundaryInputSnapshot(f.root).signature(f.config, f.args, [])).toThrow(
      /ELOOP/u,
    );
  });

  it("preserves declaration locality with native membership and complete output bytes", () => {
    const f = fixture();
    const record = f.seal(f.prepare());
    const stamp = f.file(".artifacts/record.json");
    writeArtifactRecord(stamp, record);
    expect(record.inputs).toContain("nested/value.js");
    expect(record.inputs).not.toContain("src/api.test.ts");
    expect(record.inputs?.some((file) => file.endsWith("lib.es2023.d.ts"))).toBe(true);
    const matches = () => f.matches(readArtifactRecord(stamp), f.root, Object.keys(record.outputs));
    expect(matches()).toBe(true);
    const relocated = fs.realpathSync.native(roots.make("native-boundary-relocated-"));
    fs.cpSync(f.root, relocated, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    // Relocation may change enumeration order without changing membership.
    const readdir = fs.readdirSync;
    const reordered = vi
      .spyOn(fs, "readdirSync")
      .mockImplementation((target, options) => readdir(target, options).toReversed());
    try {
      expect(f.matches(record, relocated, Object.keys(record.outputs), "dist")).toBe(true);
    } finally {
      reordered.mockRestore();
    }
    f.write("unrelated/source.ts", "export const unrelated = 2;");
    f.write("src/api.test.ts", "export const test = 2;");
    expect(matches()).toBe(true);
    for (const file of Object.keys(record.outputs)) {
      fs.utimesSync(f.file(file), new Date(2000), new Date(2000));
    }
    expect(matches()).toBe(true);
    f.write("nested/value.js", "export const value = 'changed';");
    expect(matches()).toBe(false);
  });

  describe("native record invalidation", () => {
    const invalidationRoots = useAutoCleanupTempDirTracker(afterAll);
    let f: ReturnType<typeof fixture>;
    let record: ReturnType<ReturnType<typeof fixture>["seal"]>;
    let baseline: string;

    beforeAll(() => {
      f = fixture(false, "dist", invalidationRoots);
      f.write("scripts/compile-extension-boundary.mts", "export {};");
      f.write("scripts/lib/local-check-runtime.mts", "export const policy = 1;");
      record = f.seal(f.prepare());
      baseline = invalidationRoots.make("native-boundary-pristine-");
      fs.cpSync(f.root, baseline, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    });

    const mutations = {
      rename: () => fs.renameSync(f.file("nested/value.js"), f.file("nested/renamed.js")),
      lockfile: () => f.write("pnpm-lock.yaml", "changed lock"),
      generator: () =>
        f.write("scripts/compile-extension-boundary.mts", "export const changed = true;"),
      "compiler policy": () =>
        f.write("scripts/lib/local-check-runtime.mts", "export const policy = 2;"),
      "compiler API": () => {
        const file = "node_modules/typescript/dist/api/async/api.js";
        f.write(file, `${fs.readFileSync(f.file(file), "utf8")}\n`);
      },
      "missing output": () => fs.rmSync(f.file("dist/nested/value.d.ts")),
      "tampered output": () => f.write("dist/nested/value.d.ts", "truncated"),
      "orphan output": () => f.write("dist/nested/orphan.d.ts", "export {};"),
    };
    it.each(Object.entries(mutations))(
      "rejects %s against a real native record",
      (_name, mutate) => {
        // Restore the same native generation before each independent invalidation.
        fs.rmSync(f.root, { recursive: true, force: true });
        fs.cpSync(baseline, f.root, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
        const matches = () =>
          f.matches(record, f.root, ["dist/src/api.d.ts", f.inputReceipt], "dist");
        expect(matches(), "pristine native generation").toBe(true);
        mutate();
        expect(matches()).toBe(false);
      },
    );
  });

  it("rejects a same-byte external file link in otherwise warm native membership", () => {
    const f = fixture(true);
    const declaration = ".artifacts/declared/value.d.ts";
    f.write(declaration, "export interface Value { value: 1 }");
    f.write("src/api.ts", 'export type { Value } from "../.artifacts/declared/value.js";');
    const record = f.seal(f.prepare());
    expect(record.inputs).toContain(declaration);
    expect(f.matches(record)).toBe(true);
    const external = path.join(fs.realpathSync(roots.make("external-declaration-")), "value.d.ts");
    fs.copyFileSync(f.file(declaration), external);
    fs.unlinkSync(f.file(declaration));
    // This consumed path is outside topology discovery, so byte equality alone
    // would accept the old receipt after the file starts resolving elsewhere.
    fs.symlinkSync(external, f.file(declaration), "file");
    expect(f.matches(record)).toBe(false);
  });

  it("rejects an inherited config outside the checkout before compilation", () => {
    const f = fixture(true);
    const external = path.join(fs.realpathSync(roots.make("external-config-")), "base.json");
    fs.copyFileSync(f.file("base.json"), external);
    f.write("tsconfig.json", JSON.stringify({ extends: external, include: ["src/*.ts"] }));
    expect(() => new BoundaryInputSnapshot(f.root).signature(f.config, f.args, [])).toThrow(
      "Invalid boundary config",
    );
  });

  it("rejects overlapping synchronous cache snapshots without reclaiming their live owner", () => {
    const root = fs.realpathSync(roots.make("artifact-cache-lock-"));
    const target = path.join(root, "cache/stamp.json");
    const lock = acquireBuildArtifactLock(target, 0);
    try {
      expect(() => acquireBuildArtifactLock(target, 0)).toThrow("file lock timeout");
      expect(lock.verifyStillHeld()).toBe(true);
    } finally {
      lock.release();
    }
    const successor = acquireBuildArtifactLock(target, 0);
    successor.release();
  });
});
