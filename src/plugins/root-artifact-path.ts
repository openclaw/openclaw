import path from "node:path";
import { isMissingPathError } from "../infra/errno.js";
import { pluginCacheExistsSync, readPluginCacheDirectory } from "./plugin-cache-files.js";

/** Resolves artifact paths in the caller's layout and filename preference order. */
export function resolvePluginRootArtifactPath(
  rootDir: string,
  artifactPaths: readonly string[],
): string | null {
  let checkedDirectory: string | undefined;
  let skipDirectory = false;
  for (const artifactPath of artifactPaths) {
    const candidate = path.join(rootDir, artifactPath);
    if (path.dirname(artifactPath) !== ".") {
      const directory = path.dirname(candidate);
      if (directory !== checkedDirectory) {
        try {
          skipDirectory = readPluginCacheDirectory(directory).length === 0;
        } catch (error) {
          // Directory-list permissions do not determine whether a child can be accessed.
          skipDirectory = isMissingPathError(error);
        }
        checkedDirectory = directory;
      }
      if (skipDirectory) {
        continue;
      }
    }
    if (pluginCacheExistsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
