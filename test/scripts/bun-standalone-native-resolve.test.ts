import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function probe(poisonChild: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-resolution-"));
  temporary.push(root);
  const library = path.join(root, "node_modules/fixture");
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { fixture: "1" } }),
  );
  fs.writeFileSync(
    path.join(library, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      exports: {
        ".": "./entry.cjs",
        "./alias": "./binding.node",
        "./import-only": { import: "./entry.cjs" },
      },
    }),
  );
  fs.writeFileSync(path.join(library, "entry.cjs"), "module.exports = 42;");
  fs.writeFileSync(path.join(library, "binding.node"), "synthetic native resource");
  const poison = path.join(root, "poison.mjs");
  fs.writeFileSync(
    poison,
    `
import Module from "node:module";
const original = Module.createRequire;
Module.createRequire = (filename) => {
  const require = original(filename);
  const resolve = require.resolve;
  require.resolve = Object.assign((specifier, ...args) => {
    if (specifier === "fixture/alias") {
      throw Object.assign(new Error("simulated exhausted resolver"), { code: "MODULE_NOT_FOUND" });
    }
    return resolve(specifier, ...args);
  }, { paths: resolve.paths });
  return require;
};
Module.syncBuiltinESMExports();
`,
  );
  const runner = path.join(root, "runner.mjs");
  const nativeUrl = pathToFileURL(path.resolve("scripts/lib/bun-standalone-native.mjs")).href;
  const parserUrl = pathToFileURL(
    path.resolve("scripts/lib/bun-standalone-source-parser.mjs"),
  ).href;
  fs.writeFileSync(
    runner,
    `
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
${poisonChild ? `process.env.NODE_OPTIONS = ${JSON.stringify(`--import ${pathToFileURL(poison).href}`)};` : `await import(${JSON.stringify(pathToFileURL(poison).href)});`}
const { createStandaloneNativeAdapter } = await import(${JSON.stringify(nativeUrl)});
const { createStandaloneSourceParser } = await import(${JSON.stringify(parserUrl)});
const root = ${JSON.stringify(root)};
const library = ${JSON.stringify(library)};
const adapter = createStandaloneNativeAdapter({ runtimeRoot: root, parse: createStandaloneSourceParser() });
const finalized = adapter.finalize({ metafile: { inputs: { [path.join(library, "entry.cjs")]: {} } } });
const context = vm.createContext({ root, path, fileURLToPath });
vm.runInContext(adapter.bootstrap.replace(/^import[^\\n]+\\n/, "").replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement), context);
console.log(context.__openclawStandaloneNativeResolve(path.join(root, "caller.cjs"), "fixture/alias"));
`,
  );
  return { root, result: spawnSync("node", [runner], { encoding: "utf8" }) };
}

it("captures exports in a fresh resolver when the parent reports a false missing module", () => {
  const { root, result } = probe(false);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(path.join(root, "native/fixture@1.0.0/fixture/binding.node"));
});

it("rejects a false missing-module error instead of silently dropping an export", () => {
  const { result } = probe(true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Cannot capture standalone export fixture/alias");
  expect(result.stderr).toContain("simulated exhausted resolver");
});
