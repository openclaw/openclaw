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
} from "../../scripts/lib/build-artifact-cache.mts";
import { CompilerInputSnapshot } from "../../scripts/lib/compiler-input-snapshot.mts";
import { BoundaryInputSnapshot } from "../../scripts/lib/extension-boundary-inputs.mts";
import { createDeclarationInputBoundary } from "../../scripts/lib/local-check-runtime.mts";
import { nativeTypeScriptToolchainFiles } from "../../scripts/lib/native-typescript-toolchain.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { materializeNativeCompiler } from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const compileWorker = path.resolve("scripts/compile-extension-boundary.mts");

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
  materializeNativeCompiler(root);
  const write = (file: string, bytes: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    fs.utimesSync(target, new Date(1000), new Date(1000));
  };
  write(
    "base.json",
    JSON.stringify({
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
    }),
  );
  write(
    "tsconfig.json",
    JSON.stringify({ extends: "./base.json", include: ["src/*.ts"], exclude: ["**/*.test.ts"] }),
  );
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
      compilerOptions: {
        outDir: outputRoot,
        rootDir: ".",
        declarationMap: false,
      },
      emit,
    }),
  ];
  const args = compilerArgs(config, inputReceipt, !noEmit);
  const ownedOutputRoot = noEmit ? undefined : path.join(root, outputRoot);
  const prepare = () => {
    fs.mkdirSync(path.join(root, outputRoot), { recursive: true });
    fs.rmSync(path.join(root, inputReceipt), { force: true });
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const files = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("TSFILE: "))
      .map((line) => portableRelativePath(root, line.slice(8).trim()))
      .toSorted();
    return { files };
  };
  const seal = (run: ReturnType<typeof prepare>) => {
    if (owner === "compiler") {
      const snapshot = compilerSnapshot(root);
      const { inputs }: { inputs: string[] } = JSON.parse(
        fs.readFileSync(path.join(root, inputReceipt), "utf8"),
      );
      return {
        version: ARTIFACT_CACHE_VERSION,
        signature: snapshot.signature(config, args, inputs, ownedOutputRoot),
        inputs,
        outputs: Object.fromEntries(run.files.map((file) => [file, snapshot.hash(file)])),
      };
    }
    return new BoundaryInputSnapshot(root).record(
      config,
      args,
      inputReceipt,
      run.files,
      ownedOutputRoot,
    );
  };
  const matches = (record: ReturnType<typeof seal>) =>
    owner === "compiler"
      ? compilerSnapshot(root).matches(
          record,
          config,
          args,
          Object.keys(record.outputs),
          ownedOutputRoot,
        )
      : new BoundaryInputSnapshot(root).matchesReceipt(
          record,
          config,
          args,
          Object.keys(record.outputs),
          inputReceipt,
          ownedOutputRoot,
        );
  return {
    root,
    write,
    config,
    args,
    compilerArgs,
    inputReceipt,
    prepare,
    seal,
    matches,
    outputRoot: ownedOutputRoot,
  };
}

describe("native owner content records", () => {
  it("retains upstream output topology when a producer snapshot is reused by a consumer", () => {
    const f = fixture(false, "packages/sdk/dist");
    f.write("packages/sdk/package.json", '{"name":"fixture-sdk","type":"module"}');
    f.write("consumer.json", '{"extends":"./base.json","files":["consumer.ts"]}');
    f.write(
      "consumer.ts",
      'import { value } from "fixture-sdk/dist/nested/value.js"; const expected: 1 = value;',
    );
    fs.mkdirSync(path.join(f.root, "node_modules"), { recursive: true });
    fs.symlinkSync("../packages/sdk", path.join(f.root, "node_modules/fixture-sdk"), "dir");
    const producer = f.prepare();
    const shared = new BoundaryInputSnapshot(f.root);
    shared.record(f.config, f.args, "packages/sdk/dist/.inputs.json", producer.files, f.outputRoot);
    const config = "consumer.json";
    const metadata = ".artifacts/consumer.inputs.json";
    const args = f.compilerArgs(config, metadata);
    const compiled = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8" });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const record = new BoundaryInputSnapshot(f.root).record(config, args, metadata, [metadata]);
    const matches = () =>
      new BoundaryInputSnapshot(f.root).matchesReceipt(record, config, args, [metadata], metadata);
    expect(matches()).toBe(true);
    f.write("packages/sdk/dist/nested/value.ts", 'export const value = "changed";');
    expect(matches()).toBe(false);
    const changed = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8" });
    expect(changed.status, changed.stdout + changed.stderr).toBe(1);
    expect(changed.stderr).toContain("TS2322");
  });

  it("invalidates new resolution candidates behind checkout-local linked node_modules directories", () => {
    const f = fixture(true);
    const dependency = path.join(f.root, "fixture-dependencies");
    fs.renameSync(path.join(f.root, "node_modules"), dependency);
    const packageRoot = path.join(dependency, "fixture-package");
    const moduleRoot = path.join(packageRoot, "dist");
    fs.mkdirSync(moduleRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(moduleRoot, "value.d.ts"), "export declare const value: 1;");
    fs.writeFileSync(path.join(packageRoot, "unrelated.ts"), "export const unrelated = 1;");
    fs.symlinkSync(dependency, path.join(f.root, "node_modules"), "dir");
    // Repeated aliases and a back-edge must not expand the same subtree indefinitely.
    fs.symlinkSync(packageRoot, path.join(packageRoot, "self"), "dir");
    fs.symlinkSync(f.root, path.join(packageRoot, "consumer"), "dir");
    fs.symlinkSync(packageRoot, path.join(f.root, "alias"), "dir");
    f.write(
      "src/api.ts",
      'import { value } from "fixture-package/dist/value.js"; const expected: 1 = value;',
    );
    const record = f.seal(f.prepare());
    expect(record.inputs?.some((file) => file.endsWith("/value.d.ts"))).toBe(true);
    const matches = () =>
      new BoundaryInputSnapshot(f.root).matchesReceipt(
        record,
        f.config,
        f.args,
        Object.keys(record.outputs),
        f.inputReceipt,
      );
    expect(matches()).toBe(true);
    fs.writeFileSync(path.join(packageRoot, "unrelated.ts"), "export const unrelated = 2;");
    f.write(".artifacts/ignored.ts", "export {};");
    f.write("dist/ignored.d.ts", "export {};");
    expect(matches()).toBe(true);
    fs.writeFileSync(path.join(moduleRoot, "value.ts"), 'export const value = "changed";');
    const staleHit = matches();
    const result = spawnSync(process.execPath, f.args, { cwd: f.root, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("TS2322");
    expect(result.stderr).toContain("Type '\"changed\"' is not assignable to type '1'");
    expect(staleHit).toBe(false);
  });

  it("tracks dangling link directory existence and link identity", () => {
    const f = fixture(true, "dist", roots, "compiler");
    const dependency = path.join(f.root, "fixture-dependencies");
    fs.mkdirSync(dependency);
    const target = path.join(dependency, "missing");
    const link = path.join(f.root, "missing");
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
    fs.mkdirSync(path.join(f.root, "node_modules"), { recursive: true });
    const run = f.prepare();
    // Sibling config loads mint these between the before and seal walks.
    f.write("node_modules/.vite-temp/vitest.config.ts.timestamp-1-a.mjs", "export default {};");
    const record = f.seal(run);
    expect(f.matches(record)).toBe(true);
    fs.rmSync(path.join(f.root, "node_modules/.vite-temp"), { recursive: true });
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
    fs.rmSync(path.join(f.root, "apps/macos/.build"), { recursive: true });
    expect(matches()).toBe(true);
    f.write("nested/value.ts", "export const value = 2;");
    expect(matches()).toBe(false);
  });

  it("propagates non-ENOENT link resolution errors", () => {
    const f = fixture(true);
    fs.symlinkSync("loop", path.join(f.root, "loop"));
    expect(() => new BoundaryInputSnapshot(f.root).signature(f.config, f.args, [])).toThrow(
      /ELOOP/u,
    );
  });

  it("preserves declaration locality with native membership and complete output bytes", () => {
    const f = fixture();
    const record = f.seal(f.prepare());
    const stamp = path.join(f.root, ".artifacts/record.json");
    writeArtifactRecord(stamp, record);
    expect(record.inputs).toContain("nested/value.js");
    expect(record.inputs).not.toContain("src/api.test.ts");
    expect(record.inputs?.some((file) => file.endsWith("lib.es2023.d.ts"))).toBe(true);
    const matches = () =>
      new BoundaryInputSnapshot(f.root).matchesReceipt(
        readArtifactRecord(stamp),
        f.config,
        f.args,
        Object.keys(record.outputs),
        f.inputReceipt,
        f.outputRoot,
      );
    expect(matches()).toBe(true);
    const relocated = fs.realpathSync.native(roots.make("native-boundary-relocated-"));
    fs.cpSync(f.root, relocated, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    // Relocation may change enumeration order without changing membership.
    const readdir = fs.readdirSync;
    const reordered = vi
      .spyOn(fs, "readdirSync")
      .mockImplementation((target, options) => readdir(target, options).toReversed());
    try {
      expect(
        new BoundaryInputSnapshot(relocated).matchesReceipt(
          record,
          f.config,
          f.args,
          Object.keys(record.outputs),
          f.inputReceipt,
          "dist",
        ),
      ).toBe(true);
    } finally {
      reordered.mockRestore();
    }
    f.write("unrelated/source.ts", "export const unrelated = 2;");
    f.write("src/api.test.ts", "export const test = 2;");
    expect(matches()).toBe(true);
    for (const file of Object.keys(record.outputs)) {
      fs.utimesSync(path.join(f.root, file), new Date(2000), new Date(2000));
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

    it.each([
      "rename",
      "lockfile",
      "generator",
      "compiler policy",
      "compiler API",
      "missing output",
      "tampered output",
      "orphan output",
    ])("rejects %s against a real native record", (mutation) => {
      // Restore the same native generation before each independent invalidation.
      fs.rmSync(f.root, { recursive: true, force: true });
      fs.cpSync(baseline, f.root, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      const matches = () =>
        new BoundaryInputSnapshot(f.root).matchesReceipt(
          record,
          f.config,
          f.args,
          ["dist/src/api.d.ts", f.inputReceipt],
          f.inputReceipt,
          "dist",
        );
      expect(matches(), "pristine native generation").toBe(true);
      switch (mutation) {
        case "rename":
          fs.renameSync(
            path.join(f.root, "nested/value.js"),
            path.join(f.root, "nested/renamed.js"),
          );
          break;
        case "lockfile":
          f.write("pnpm-lock.yaml", "changed lock");
          break;
        case "generator":
          f.write("scripts/compile-extension-boundary.mts", "export const changed = true;");
          break;
        case "compiler policy":
          f.write("scripts/lib/local-check-runtime.mts", "export const policy = 2;");
          break;
        case "compiler API": {
          const file = "node_modules/typescript/dist/api/async/api.js";
          f.write(file, `${fs.readFileSync(path.join(f.root, file), "utf8")}\n`);
          break;
        }
        case "missing output":
          fs.rmSync(path.join(f.root, "dist/nested/value.d.ts"));
          break;
        case "tampered output":
          f.write("dist/nested/value.d.ts", "truncated");
          break;
        case "orphan output":
          f.write("dist/nested/orphan.d.ts", "export {};");
          break;
      }
      expect(matches()).toBe(false);
    });
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
    fs.copyFileSync(path.join(f.root, declaration), external);
    fs.unlinkSync(path.join(f.root, declaration));
    // This consumed path is outside topology discovery, so byte equality alone
    // would accept the old receipt after the file starts resolving elsewhere.
    fs.symlinkSync(external, path.join(f.root, declaration), "file");
    expect(f.matches(record)).toBe(false);
  });

  it("rejects an inherited config outside the checkout before compilation", () => {
    const f = fixture(true);
    const external = path.join(fs.realpathSync(roots.make("external-config-")), "base.json");
    fs.copyFileSync(path.join(f.root, "base.json"), external);
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
