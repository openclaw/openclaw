import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isEmbeddedStandaloneModule } from "../../cli-invocation.mjs";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

/** Resolve a declared entry in the selected host package, including source checkouts. */
export function resolvePackageRuntimeProcessEntrypointUrl(
  name: keyof typeof runtimeProcessEntrypoints,
  packageRoot: string,
): URL {
  const entry = runtimeProcessEntrypoints[name];
  const built = path.join(packageRoot, "dist", entry.distWorkerPath);
  if (isEmbeddedStandaloneModule(built) || fs.existsSync(built)) {
    return pathToFileURL(built);
  }
  const source = path.join(packageRoot, entry.sourceModulePath);
  if (fs.existsSync(source)) {
    return pathToFileURL(source);
  }
  throw new Error(`Runtime process entry ${name} is missing under ${packageRoot}`);
}
