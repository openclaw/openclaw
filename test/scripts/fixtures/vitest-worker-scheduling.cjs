const { createRequire, registerHooks, runMain } = require("node:module");
const { pathToFileURL } = require("node:url");

const [compiler, directory, failShared] = process.argv.slice(2);
const tsdown = pathToFileURL(createRequire(compiler).resolve("tsdown")).href;
const events = [];
let active = 0;
let maxActive = 0;
let failure;
const reportError = console.error;
console.error = (...args) => {
  if (args[0] instanceof Error && args[0].message === "controlled tsdown failure") {
    failure = { active, events: [...events] };
  }
  reportError(...args);
};

// Control the public build boundary, leaving cache admission and compiler entry intact.
exports.build = async (config) => {
  const graph = config.unbundle ? "preserved" : "shared";
  events.push(`start:${graph}`);
  maxActive = Math.max(maxActive, ++active);
  try {
    await new Promise(setImmediate);
    if (graph === "preserved" || failShared === "fail-shared") {
      throw new Error("controlled tsdown failure");
    }
  } finally {
    events.push(`end:${graph}`);
    active--;
  }
};
registerHooks({
  load(url, context, nextLoad) {
    return url === tsdown
      ? {
          format: "commonjs",
          source: `module.exports = require(${JSON.stringify(__filename)});`,
          shortCircuit: true,
        }
      : nextLoad(url, context);
  },
});
Object.defineProperty(process, "availableMemory", { value: () => 16 * 1024 ** 3 });
process.on("exit", () => {
  console.log(JSON.stringify({ events, active, maxActive, failure, execArgv: process.execArgv }));
});
// A normal CJS main installs the dependency hook; no startup hooks disable the real cache.
process.argv = [process.execPath, compiler, directory];
runMain(compiler);
