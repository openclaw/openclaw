import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneCodegenTransform } from "../../scripts/lib/bun-standalone-codegen.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";
import { requirePinnedBun } from "../../scripts/lib/pinned-bun.mjs";
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
  it.skipIf(process.platform === "win32")("captures remaining static programs", () => {
    const root = fs.realpathSync(dirs.make("standalone-capture-"));
    const runtimeRoot = path.join(root, "runtime");
    const dist = path.join(runtimeRoot, "dist");
    fs.mkdirSync(path.join(dist, "worker"), { recursive: true });
    const sources = [
      ["staged-inputs", "src/media/staged-inputs.ts"],
      ["workspace-manifest", "src/gateway/worker-environments/workspace-path-exclusions.ts"],
      ["workspace-hash-memo", "src/gateway/worker-environments/workspace-hash-memo.ts"],
      ["workspace-seed-retention", "src/worker/workspace-seed-retention.ts"],
    ].map(([name, owner], index) => {
      const filename = path.join(dist, `${name}-fixture.mjs`);
      fs.writeFileSync(
        filename,
        `import { compileFunction } from "node:vm";
//#region ${owner}
const SOURCE${index} = "const offset = ${index + 1};";
export const run = compileFunction(\`\${SOURCE${index}}\nreturn value + offset + ${index};\`, ["value"]);`,
      );
      return filename;
    });
    fs.writeFileSync(
      path.join(dist, "workspace-manifest-script.runtime-fixture.mjs"),
      "//#region src/gateway/worker-environments/workspace-manifest-script.runtime.ts\nexport function run() { return 99; }\n",
    );
    const receiver = path.join(dist, "worker/workspace-rsync-receiver.mjs");
    fs.writeFileSync(
      receiver,
      `import { compileFunction } from "node:vm";
const REMOTE_WORKSPACE_ACCEPTED_RSYNC_RECEIVER_JS = "return 41;";
const REMOTE_WORKSPACE_RSYNC_RECEIVER_JS = "return 42;";
//#region src/worker/workspace-rsync-receiver.ts
export const select = (accepted) => compileFunction(accepted ? REMOTE_WORKSPACE_ACCEPTED_RSYNC_RECEIVER_JS : REMOTE_WORKSPACE_RSYNC_RECEIVER_JS, ["require"]);`,
    );
    const driver = path.join(root, "capture.mjs");
    fs.writeFileSync(
      driver,
      `import fs from "node:fs";
import vm from "node:vm";
import { createStandaloneCodegenAdapter } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-codegen.mjs", import.meta.url).href)};
import { createStandaloneSourceParser } from ${JSON.stringify(new URL("../../scripts/lib/bun-standalone-source-parser.mjs", import.meta.url).href)};
const adapter = await createStandaloneCodegenAdapter({runtimeRoot:${JSON.stringify(runtimeRoot)},outputRoot:${JSON.stringify(path.join(root, "output"))},parse:createStandaloneSourceParser()});
const values = ${JSON.stringify(sources)}.map(filename => {
  const result = adapter.transform({filename,contents:fs.readFileSync(filename,"utf8")});
  if (result.count !== 1) throw new Error("Missing fixed program transform");
  return vm.runInNewContext(result.contents.replace(/^import[^;]+;/, "").replace("export ", "") + "\\nrun(40)");
});
const receiver = adapter.transform({filename:${JSON.stringify(receiver)},contents:fs.readFileSync(${JSON.stringify(receiver)},"utf8")});
const selected = vm.runInNewContext(receiver.contents.replace(/^import[^;]+;/, "").replace("export ", "") + "\\n[select(true)(),select(false)()]");
console.log(JSON.stringify({programs:adapter.programs.length,values,selected,residuals:adapter.residuals}));
`,
    );
    const result = spawnSync(requirePinnedBun(), [driver], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      programs: 6,
      values: [41, 43, 45, 47],
      selected: [41, 42],
      residuals: [],
    });
  });

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
