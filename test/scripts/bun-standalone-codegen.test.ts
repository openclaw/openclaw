import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneCodegenTransform } from "../../scripts/lib/bun-standalone-codegen.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { typeCheckSources } from "../helpers/typescript.js";

const parse = createStandaloneSourceParser();
const dirs = useAutoCleanupTempDirTracker(afterEach);

const program = {
  signature: "SOURCE\nreturn value + prefix;",
  code: "const prefix = 3;\nreturn value + prefix;",
  params: ["value"],
};

describe("standalone fixed code generation", () => {
  it("keeps captured JavaScript outside typed callers and creates a fresh function per call", async () => {
    const directory = dirs.make("typed-static-program-");
    const programModule = path.join(directory, "programs.mjs");
    const transform = createStandaloneCodegenTransform({
      programs: [program],
      parse: createStandaloneSourceParser(),
      programModule,
    });
    fs.writeFileSync(programModule, transform.moduleSource);
    fs.writeFileSync(path.join(directory, "programs.d.mts"), transform.declarationSource);
    const source = `import { compileFunction } from "node:vm";
const SOURCE = "const prefix = 3;";
const first = compileFunction(\`\${SOURCE}\nreturn value + prefix;\`, ["value"]);
const second = compileFunction(\`\${SOURCE}\nreturn value + prefix;\`, ["value"]);
const input: number = 4;
export const result = [first(input), first === second];`;
    const filename = path.join(directory, "caller.mts");
    const result = transform.transform({ filename, contents: source, preserveTypes: true });
    fs.writeFileSync(filename, result.contents);
    expect(
      typeCheckSources({ [filename]: `/// <reference types="node" />\n${result.contents}` }),
    ).toEqual([]);
    const executable = path.join(directory, "caller.mjs");
    fs.writeFileSync(executable, stripTypeScriptTypes(result.contents));
    expect((await import(pathToFileURL(executable).href)).result).toEqual([7, false]);
    expect(transform.residuals).toEqual([]);
  });

  it("emits an executable lexical function and respects a shadowed compiler binding", () => {
    const transform = createStandaloneCodegenTransform({
      programs: [program],
      parse,
      programModule: undefined,
    });
    const source = `import { compileFunction as compile } from "node:vm";
const SOURCE = "const prefix = 3;";
const fn = compile(\`\${SOURCE}\nreturn value + prefix;\`, ["value"]);
function local(compile) { return compile("not a fixed program"); }
[fn(4), local(() => 11)];`;
    const result = transform.transform({ filename: "/runtime/dist/example.mjs", contents: source });
    expect(result.count).toBe(1);
    expect(vm.runInNewContext(result.contents.slice(result.contents.indexOf("\n") + 1))).toEqual([
      7, 11,
    ]);
    expect(transform.residuals).toEqual([]);
  });

  it("records unsupported runtime programs instead of inventing captured behavior", () => {
    const transform = createStandaloneCodegenTransform({
      programs: [program],
      parse,
      programModule: undefined,
    });
    const source = `import { compileFunction } from "node:vm";
export const dynamic = (source) => compileFunction(source, []);`;
    expect(transform.transform({ filename: "dynamic.mjs", contents: source }).contents).toBe(
      source,
    );
    expect(transform.residuals).toEqual([
      { filename: "dynamic.mjs", expression: "compileFunction(source, [])" },
    ]);
  });

  it.each([false, true])("preserves JIT library behavior unless AOT is requested (%s)", (aot) => {
    const transform = createStandaloneCodegenTransform({
      programs: [],
      parse,
      aot,
      programModule: undefined,
    });
    const source = "Error.stackTraceLimit = 9; delete Error.prepareStackTrace;";
    const result = transform.transform({ filename: "library.mjs", contents: source });
    expect(result.guardedIntrinsicWrites).toBe(aot ? 2 : 0);
    if (!aot) {
      expect(result.contents).toBe(source);
    }
    const Error = Object.freeze({ stackTraceLimit: 2, prepareStackTrace: undefined });
    if (aot) {
      expect(() => vm.runInNewContext(`'use strict'; ${result.contents}`, { Error })).not.toThrow();
      expect(Error.stackTraceLimit).toBe(2);
    } else {
      expect(() => vm.runInNewContext(`'use strict'; ${result.contents}`, { Error })).toThrow();
    }
  });

  it("only disables TypeBox acceleration in AOT mode", () => {
    const source = "export function CanEvaluate() { return true; }";
    const filename = "/runtime/node_modules/typebox/build/system/environment/evaluate.mjs";
    for (const aot of [false, true]) {
      const transform = createStandaloneCodegenTransform({
        programs: [],
        parse,
        aot,
        programModule: undefined,
      });
      const result = transform.transform({ filename, contents: source });
      const evaluate = vm.runInNewContext(
        `${result.contents.replace("export ", "")} CanEvaluate;`,
        {
          Settings: { Get: () => ({ useAcceleration: false }) },
        },
      );
      expect(evaluate()).toBe(!aot);
      if (!aot) {
        expect(result.contents).toBe(source);
      }
    }
  });
});
