const fs = require("node:fs");
const Module = require("node:module");
const { fileURLToPath, pathToFileURL } = require("node:url");

// Synthetic child fixtures replace builtin methods before loading their owners.
/** @param {string[]} [names] */
exports.syncFixtureBuiltinExports = function syncFixtureBuiltinExports(
  names = ["node:child_process", "node:fs"],
) {
  if (!process.versions.bun) {
    Module.syncBuiltinESMExports();
    return;
  }
  const { mock } = require("bun:test");
  for (const name of names) {
    const builtin = require(name);
    mock.module(name, () => ({ ...builtin, default: builtin }));
  }
};

/** @param {string} preload @param {"node" | "bun"} runtime */
function preloadSpecifier(preload, runtime) {
  const url = pathToFileURL(preload).href;
  if (runtime === "node") {
    return url;
  }
  // BUN_OPTIONS cannot quote paths with spaces; import the original file by URL.
  const loader = Buffer.from(`import ${JSON.stringify(url)};`).toString("base64");
  return `data:text/javascript;base64,${loader}`;
}

/** @param {string} preload */
exports.fixturePreloadArgs = function fixturePreloadArgs(preload) {
  return ["--import", preloadSpecifier(preload, process.versions.bun ? "bun" : "node")];
};

/** @param {string} preload @param {"node" | "bun"} [runtime] */
exports.fixturePreloadEnv = function fixturePreloadEnv(
  preload,
  runtime = process.versions.bun ? "bun" : "node",
) {
  const specifier = preloadSpecifier(preload, runtime);
  return runtime === "bun"
    ? { BUN_OPTIONS: `--preload=${specifier}` }
    : { NODE_OPTIONS: `--import=${specifier}` };
};

/** @param {string[]} urls */
exports.fixtureSourceFileFilter = function fixtureSourceFileFilter(urls) {
  const paths = urls.map((url) =>
    fileURLToPath(url)
      .replaceAll("\\", "/")
      .split("/")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[/\\\\]"),
  );
  return new RegExp(`^(?:${paths.join("|")})$`);
};

/**
 * @param {{name: string, filter: RegExp, transform: (url: string, readSource: () => string) => string}} options
 */
exports.registerFixtureSourceTransform = function registerFixtureSourceTransform(options) {
  if (process.versions.bun) {
    require("bun").plugin({
      name: options.name,
      setup(builder) {
        // Bun invokes only the first matching loader and requires a concrete result.
        builder.onLoad({ filter: options.filter }, ({ path: filename }) => ({
          contents: options.transform(pathToFileURL(filename).href, () =>
            fs.readFileSync(filename, "utf8"),
          ),
          loader: /\.[cm]?ts$/.test(filename) ? "ts" : "js",
        }));
      },
    });
    return;
  }
  Module.registerHooks({
    load(url, context, nextLoad) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "file:" ||
        parsed.search ||
        parsed.hash ||
        !options.filter.test(fileURLToPath(parsed))
      ) {
        return nextLoad(url, context);
      }
      let loaded;
      const source = options.transform(url, () => {
        loaded ??= nextLoad(url, context);
        return typeof loaded.source === "string"
          ? loaded.source
          : Buffer.from(loaded.source).toString("utf8");
      });
      return loaded ? { ...loaded, source } : { format: "module", shortCircuit: true, source };
    },
  });
};
