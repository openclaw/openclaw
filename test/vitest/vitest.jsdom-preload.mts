import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installJsdomEnvironmentAdapter } from "../jsdom-compat.mts";

// Prefer the executing Vitest installation; plain children can inherit this preload
// from a worker while their entrypoints live outside the dependency tree.
const require = createRequire(import.meta.url);
const runtimePath = require.resolve("vitest/runtime", {
  paths: [...(process.argv[1] ? [path.dirname(process.argv[1])] : []), import.meta.dirname],
});
const { builtinEnvironments }: typeof import("vitest/runtime") = await import(
  pathToFileURL(runtimePath).href
);
installJsdomEnvironmentAdapter(builtinEnvironments.jsdom);
