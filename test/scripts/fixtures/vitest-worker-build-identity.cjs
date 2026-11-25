const fs = require("node:fs");
const path = require("node:path");
const { createRequire, registerHooks, runMain } = require("node:module");
const { pathToFileURL } = require("node:url");

const [compiler, directory, metadata, mode] = process.argv.slice(2);
const root = path.resolve(path.dirname(compiler), "../..");
const requireCompiler = createRequire(compiler);
const compilerUrl = pathToFileURL(compiler).href;
const compile = require(requireCompiler.resolve("tsdown")).build;
const readFileSync = fs.readFileSync;
fs.readFileSync = function (filename, ...args) {
  return readFileSync.call(
    this,
    filename === path.join(root, "dist/build-info.json") ? metadata : filename,
    ...args,
  );
};
let builds = 0;
exports.build = async (config) => {
  if (mode === "restore") {
    throw new Error("Cache restoration invoked the compiler");
  }
  builds++;
  return compile(config);
};
const replacements = new Map([
  [
    pathToFileURL(path.join(root, "scripts/lib/vitest-worker-build-entries.mts")).href,
    `export const vitestWorkerBuildEntries = {
      "infra/sqlite-readonly-location.worker": original.vitestWorkerBuildEntries["infra/sqlite-readonly-location.worker"],
    };
    export const preservedModuleBuildSources = ["src/infra/runtime-process-entrypoints.ts"];`,
  ],
  [
    pathToFileURL(path.join(root, "scripts/lib/vitest-worker-declarations.mts")).href,
    `export const vitestWorkerDeclarationEntries = {
      "infra/runtime-process-entrypoints": original.vitestWorkerDeclarationEntries["infra/runtime-process-entrypoints"],
    };`,
  ],
]);
// Keep real cache admission and the compiler's main entry; narrow only public
// compilation inputs and redirect host metadata into this fixture's own file.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "tsdown" && context.parentURL === compilerUrl) {
      return { url: pathToFileURL(__filename).href, format: "commonjs", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const replacement = replacements.get(url);
    if (replacement) {
      const original = JSON.stringify(`${url}?fixture-original`);
      return {
        format: "module",
        source: `export * from ${original}; import * as original from ${original}; ${replacement}`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
process.on("exit", () => console.log(JSON.stringify({ builds, execArgv: process.execArgv })));
process.argv = [process.execPath, compiler, directory];
runMain(compiler);
