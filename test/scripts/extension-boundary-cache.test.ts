import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  portableRelativePath,
  type ArtifactRecord,
} from "../../scripts/lib/build-artifact-cache.mts";
import { BoundaryInputSnapshot } from "../../scripts/lib/extension-boundary-inputs.mts";
import { createDeclarationInputBoundary } from "../../scripts/lib/local-check-runtime.mts";
import { compileNativeProject } from "../../scripts/lib/native-declaration-emitter.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { materializeNativeCompiler, writeNativeFixtureFile } from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("reuses observed compiler lookups and rejects newly effective resolutions", async () => {
  const parent = fs.realpathSync.native(roots.make("native-boundary-cache-"));
  const root = path.join(parent, "checkout");
  fs.mkdirSync(root);
  materializeNativeCompiler(root);
  const write = (file: string, text: string) => writeNativeFixtureFile(root, file, text);
  const marker = (type = '"ok"') => `export type Marker = ${type};\n`;
  const globalType = (field: string) =>
    `export {}; declare global { interface FixtureGlobal { ${field}: true } }\n`;
  const entry = (module: string, suffix = "") =>
    `import type { Marker } from "${module}";\nexport const value: Marker = "ok";\n${suffix}`;
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const compilerFile = "node_modules/typescript/dist/zz-cache-identity.js";
  const renamedCompilerFile = "node_modules/typescript/dist/zzz-cache-identity.js";
  write(compilerFile, "export {};\n");
  for (const name of ["first", "second"]) {
    write(`compiler-helpers/${name}/runtime.js`, "export {};\n");
  }
  const compilerAlias = path.join(root, "node_modules/typescript/dist/cache-identity");
  fs.symlinkSync(path.join(root, "compiler-helpers/first"), compilerAlias, linkType);
  const config = "tsconfig.json";
  const receipt = ".artifacts/boundary.inputs.json";
  const args = ["native-boundary-cache"];
  const configure = (options: Record<string, unknown> = {}) =>
    write(
      config,
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ES2023",
          types: [],
          skipLibCheck: true,
          ...options,
        },
        files: ["src/index.ts"],
      }),
    );
  write("package.json", '{"type":"module"}\n');
  configure({ paths: { "#contract": ["./src/preferred.ts", "./src/fallback.ts"] } });
  write("src/index.ts", entry("#contract", "export const meta = import.meta;\n"));
  write("src/fallback.ts", marker());
  const boundary = createDeclarationInputBoundary(root);
  const compile = () =>
    compileNativeProject({
      cwd: root,
      compilerRoot: root,
      configFile: path.join(root, config),
      assertInput: (file) => boundary.assert(file),
      emit: false,
    });
  const publish = async () => {
    const result = await compile();
    const inputs = result.inputs.map((file) => portableRelativePath(root, file)).toSorted();
    write(receipt, `${JSON.stringify({ inputs, lookups: result.lookups })}\n`);
    return new BoundaryInputSnapshot(root).record(config, args, receipt, [receipt]);
  };
  const matches = (record: ArtifactRecord) =>
    new BoundaryInputSnapshot(root).matchesReceipt(record, config, args, [receipt], receipt);
  const record = await publish();
  const edit = async (file: string, text: string | null, valid: boolean, diagnostic?: RegExp) => {
    if (text === null) {
      fs.unlinkSync(path.join(root, file));
    } else {
      write(file, text);
    }
    expect(matches(record)).toBe(valid);
    if (diagnostic) {
      await expect(compile()).rejects.toThrow(diagnostic);
    }
  };
  expect(matches(record)).toBe(true);
  const captured = new BoundaryInputSnapshot(root);
  expect(captured.matchesReceipt(record, config, args, [receipt], receipt)).toBe(true);
  expect(captured.matchesReceipt(record, config, args, [receipt], receipt)).toBe(true);
  fs.renameSync(path.join(root, compilerFile), path.join(root, renamedCompilerFile));
  expect(matches(record), "compiler filename must invalidate identical bytes").toBe(false);
  fs.renameSync(path.join(root, renamedCompilerFile), path.join(root, compilerFile));
  expect(matches(record)).toBe(true);
  fs.unlinkSync(compilerAlias);
  fs.symlinkSync(path.join(root, "compiler-helpers/second"), compilerAlias, linkType);
  expect(matches(record)).toBe(false);
  fs.unlinkSync(compilerAlias);
  fs.symlinkSync(path.join(root, "compiler-helpers/first"), compilerAlias, linkType);
  expect(matches(record)).toBe(true);
  await edit("unrelated/new.test.ts", 'export const unrelated: number = "invalid";\n', true);

  const ancestorInstall = path.join(parent, "node_modules");
  fs.mkdirSync(ancestorInstall);
  expect(matches(record)).toBe(false);
  fs.rmdirSync(ancestorInstall);
  expect(matches(record)).toBe(true);

  const originalReceipt = fs.readFileSync(path.join(root, receipt), "utf8");
  for (const contents of [
    JSON.stringify({ inputs: record.inputs }),
    JSON.stringify({ inputs: record.inputs, lookups: [] }),
  ]) {
    write(receipt, contents);
    const forgedOutput = {
      ...record,
      outputs: { [receipt]: new BoundaryInputSnapshot(root).hash(receipt) },
    };
    expect(matches(forgedOutput)).toBe(false);
  }
  write(receipt, originalReceipt);
  expect(matches({ ...record, inputs: [] })).toBe(false);
  expect(matches(record)).toBe(true);

  await edit("src/fallback.ts", null, false);
  await edit("src/fallback.ts", marker(), true);
  await edit("src/fallback.ts", marker("number"), false, /TS2322/u);
  await edit("src/fallback.ts", marker(), true);
  await edit("src/preferred.ts", marker("number"), false, /TS2322/u);
  await edit("src/preferred.ts", null, true);
  await edit("src/package.json", '{"type":"commonjs"}\n', false, /TS1470/u);
  fs.unlinkSync(path.join(root, "src/package.json"));

  configure({ types: ["*"], typeRoots: ["./ambient"] });
  write(
    "src/index.ts",
    "export const values: Record<keyof FixtureGlobal, number> = { known: 1 };\n",
  );
  write("ambient/base/index.d.ts", globalType("known"));
  const ambient = await publish();
  expect(matches(ambient)).toBe(true);
  write("ambient/added/index.d.ts", globalType("added"));
  expect(matches(ambient)).toBe(false);
  await expect(compile()).rejects.toThrow(/TS2741/u);

  configure();
  write("src/index.ts", entry("fixture-package"));
  for (const [name, type] of Object.entries({ first: '"ok"', second: "number" })) {
    write(`packages/${name}/package.json`, '{"name":"fixture-package","types":"index.d.ts"}\n');
    write(
      `packages/${name}/index.d.ts`,
      'import type { Value } from "./value.js";\nexport type Marker = Value;\n',
    );
    write(`packages/${name}/value.d.ts`, `export type Value = ${type};\n`);
  }
  const alias = path.join(root, "node_modules/fixture-package");
  fs.symlinkSync(path.join(root, "packages/first"), alias, linkType);
  const linked = await publish();
  expect(matches(linked)).toBe(true);
  fs.unlinkSync(alias);
  fs.symlinkSync(path.join(root, "packages/second"), alias, linkType);
  expect(matches(linked)).toBe(false);
  await expect(compile()).rejects.toThrow(/TS2322/u);
});
