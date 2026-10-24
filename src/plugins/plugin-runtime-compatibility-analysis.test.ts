import { describe, expect, it } from "vitest";
import { analyzePluginRuntimeCompatibility } from "./plugin-runtime-compatibility-analysis.js";

describe("plugin runtime compatibility analysis", () => {
  it("tracks built-in receivers through aliases, reflection, and Node imports", () => {
    const warnings = analyzePluginRuntimeCompatibility(
      `
import { Buffer as Bytes } from "node:buffer";
const prototype = Array.prototype;
const define = Object.defineProperty;
prototype.push = () => 1;
define(Bytes, "concat", { value: () => null });
Reflect.set(Object.prototype, "extra", 1);
delete Map.prototype.get;
`,
      "entry.ts",
    );
    expect(warnings.map(({ ruleId, reference, line }) => ({ ruleId, reference, line }))).toEqual([
      { ruleId: "builtin-patch", reference: "Array.prototype.push", line: 5 },
      { ruleId: "builtin-patch", reference: "Buffer.concat", line: 6 },
      { ruleId: "builtin-patch", reference: "Object.prototype.extra", line: 7 },
      { ruleId: "builtin-patch", reference: "Map.prototype.get", line: 8 },
    ]);
  });

  it("distinguishes own classes, instances, shadowed names, reads, and permitted additions", () => {
    const source = `
class Owned { push() {} }
Owned.prototype.push = () => 2;
const instance = new Response();
Object.defineProperty(instance, "url", { value: "https://example.test" });
function local(Array, Function, eval, console) {
  Array.prototype.push = () => 3;
  new Function("return 1");
  Function.apply(null, ["return 1"]);
  eval("code");
  eval.call(null, "code");
  console.log = () => {};
}
const own = { prototype: {} };
own.prototype.push = () => 4;
Array.prototype.last = function () { return this[this.length - 1]; };
const push = Array.prototype.push;
const fn = new Owned();
fn.push = () => 5;
const ownedFunction = () => {};
ownedFunction.apply(null, []);
const { EventEmitter } = require("node:events");
const emitter = new EventEmitter();
emitter.emit = () => true;
class OwnedEmitter extends EventEmitter {}
OwnedEmitter.prototype.emit = () => true;
process.env.EXAMPLE = "1";
eval();
eval(42);
eval(-1);
eval(false);
eval(null);
eval(undefined);
eval({ toString() { return "source"; } });
eval(() => {});
eval.call(null, 42);
eval.apply(null, [null]);
Reflect.apply(eval, null, [123]);
`;
    expect(analyzePluginRuntimeCompatibility(source, "entry.js")).toEqual([]);
    expect(analyzePluginRuntimeCompatibility("const element = <div />;", "entry.mtsx")).toEqual([]);
  });

  it("identifies host-dependent writers separately from immutable builtins", () => {
    const warnings = analyzePluginRuntimeCompatibility(
      `
const host = globalThis;
host.fetch = async () => new Response();
const { console: output } = globalThis;
output.log = () => {};
const proc = require("process");
proc.chdir = () => {};
const fs = require("node:fs");
fs.readFileSync = () => "changed";
JSON.parse = () => null;
const files = require("node:fs/promises");
files.readFile = () => null;
const timers = require("node:timers");
timers.setTimeout = () => null;
const crypto = require("node:crypto");
crypto.randomBytes = () => null;
const util = require("node:util");
util.inspect = () => "";
`,
      "entry.cjs",
    );
    expect(warnings.map(({ ruleId, reference }) => ({ ruleId, reference }))).toEqual([
      { ruleId: "host-patch", reference: "fetch" },
      { ruleId: "host-patch", reference: "console.log" },
      { ruleId: "host-patch", reference: "process.chdir" },
      { ruleId: "host-patch", reference: "node:fs.readFileSync" },
      { ruleId: "host-patch", reference: "JSON.parse" },
      { ruleId: "host-patch", reference: "node:fs/promises.readFile" },
      { ruleId: "host-patch", reference: "node:timers.setTimeout" },
      { ruleId: "host-patch", reference: "node:crypto.randomBytes" },
      { ruleId: "host-patch", reference: "node:util.inspect" },
    ]);
  });

  it("resolves aliases in their declaration scope and distinguishes reserved prototype names", () => {
    const warnings = analyzePluginRuntimeCompatibility(
      `
const HostArray = Array;
function patch(Array) { HostArray.prototype.push = () => 1; }
Array.prototype.toJSON = () => [];
Array.prototype.next = () => ({});
Array.prototype.return = () => ({});
Array.prototype.throw = () => ({});
Map.prototype.toJSON = () => ({});
Set.prototype.toJSON = () => [];
BigInt.prototype.toJSON = () => "1";
Date.prototype.next = () => ({});
`,
      "entry.js",
    );
    expect(warnings.map(({ reference }) => reference)).toEqual([
      "Array.prototype.push",
      "Array.prototype.toJSON",
      "Array.prototype.next",
      "Array.prototype.return",
      "Array.prototype.throw",
    ]);
  });

  it("reports runtime generation and loader interception without executing source", () => {
    const warnings = analyzePluginRuntimeCompatibility(
      `
import { runInThisContext as run } from "node:vm";
const VM = require("vm");
const Module = require("node:module");
const Generate = Function;
new Generate("return 42");
run("throw new Error('must not run')");
new VM.Script("1 + 1");
Module._extensions[".js"] = () => {};
eval("throw new Error('must not run')");
Function.apply(null, ["return 1"]);
const apply = Function.apply;
apply(null, ["return 1"]);
eval.call(globalThis, "throw new Error('must not run')");
Reflect.apply(Function, null, ["return 1"]);
Reflect.construct(Function, ["return 1"]);
new Function(123);
eval(unknownSource);
`,
      "entry.js",
    );
    expect(warnings.map(({ ruleId, reference }) => ({ ruleId, reference }))).toEqual([
      { ruleId: "runtime-code-generation", reference: "Function" },
      { ruleId: "runtime-code-generation", reference: "node:vm.runInThisContext" },
      { ruleId: "runtime-code-generation", reference: "node:vm.Script" },
      { ruleId: "loader-patch", reference: "node:module._extensions..js" },
      { ruleId: "runtime-code-generation", reference: "eval" },
      { ruleId: "runtime-code-generation", reference: "Function.apply" },
      { ruleId: "runtime-code-generation", reference: "Function.apply" },
      { ruleId: "runtime-code-generation", reference: "eval.call" },
      { ruleId: "runtime-code-generation", reference: "Function" },
      { ruleId: "runtime-code-generation", reference: "Function" },
      { ruleId: "runtime-code-generation", reference: "Function" },
      { ruleId: "runtime-code-generation", reference: "eval" },
    ]);
  });

  it("inspects feature-detected calls without evaluating them", () => {
    const warnings = analyzePluginRuntimeCompatibility(
      `
const Module = process.getBuiltinModule?.("module");
eval?.("throw new Error('must not run')");
eval?.(42);
Module.registerHooks?.({});
Object.defineProperty?.(Array.prototype, "push", { value: () => 1 });
`,
      "optional.js",
    );
    expect(warnings.map(({ ruleId, reference }) => ({ ruleId, reference }))).toEqual([
      { ruleId: "runtime-code-generation", reference: "eval" },
      { ruleId: "loader-patch", reference: "node:module.registerHooks" },
      { ruleId: "builtin-patch", reference: "Array.prototype.push" },
    ]);
  });

  it("does not mistake optional or guarded code for a proven runtime failure", () => {
    const [warning] = analyzePluginRuntimeCompatibility(
      `
if (!globalThis.fetch) globalThis.fetch = async () => new Response();
`,
      "optional.js",
    );
    expect(warning?.ruleId).toBe("host-patch");
    expect(warning?.message).toContain("depends on the host");
  });
});
