import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isEmbeddedStandaloneModule, resolveStandaloneNpmCliPath } from "../../cli-invocation.mjs";
import {
  pluginRuntimeProcessManifest,
  runtimeProcessDependencyEntrypoints,
} from "./runtime-process-manifest.ts";

/** Resolve dependency programs from the calling package, preserving its installed dependencies. */
export function resolveRuntimeDependencyEntrypointUrl(
  name: keyof typeof runtimeProcessDependencyEntrypoints,
  moduleUrl: string,
): URL {
  const entry = runtimeProcessDependencyEntrypoints[name];
  const require = createRequire(moduleUrl);
  if (entry.kind === "standalone-package-manager") {
    const standaloneNpm = resolveStandaloneNpmCliPath();
    return pathToFileURL(
      standaloneNpm
        ? path.join(path.dirname(standaloneNpm), path.basename(entry.relativePath))
        : path.join(path.dirname(require.resolve(entry.packageJsonSpecifier)), entry.relativePath),
    );
  }
  return pathToFileURL(require.resolve(entry.specifier));
}

export { resolveRuntimeDependencyEntrypointUrlFromDirectory } from "../../runtime-process-bootstrap.generated.mjs";

type PluginAssetEntrypointName = {
  [
    Name in keyof typeof pluginRuntimeProcessManifest
  ]: (typeof pluginRuntimeProcessManifest)[Name] extends {
    build: "static-asset";
  }
    ? Name
    : never;
}[keyof typeof pluginRuntimeProcessManifest];

/** Copied plugin programs retain their source, bundled, and installed package layouts. */
export function resolvePluginRuntimeProcessAssetUrl(
  name: PluginAssetEntrypointName,
  packageRoot: string,
): URL {
  const entry = pluginRuntimeProcessManifest[name];
  const pluginSourceRoot = `extensions/${entry.plugin}`;
  const candidates = [
    path.join(
      packageRoot,
      path.posix.relative(
        pluginSourceRoot,
        path.posix.join(
          path.posix.dirname(entry.ownerSource),
          `${entry.sourceWorkerName}${entry.sourceExtension}`,
        ),
      ),
    ),
    path.join(packageRoot, path.posix.relative(pluginSourceRoot, entry.distWorkerPath)),
    path.join(packageRoot, "dist", entry.package.distWorkerPath),
  ];
  const selected =
    candidates.find((candidate) => isEmbeddedStandaloneModule(candidate)) ??
    candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) {
    throw new Error(`[${entry.plugin}] launcher not found; searched ${candidates.join(", ")}`);
  }
  return pathToFileURL(selected);
}
