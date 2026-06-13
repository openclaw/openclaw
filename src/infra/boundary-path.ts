// Exposes boundary path resolution helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Boundary path resolution keeps alias expansion and realpath checks in one
// shared contract before file IO happens.
import { resolvePathViaExistingAncestorSync as _resolvePathViaExistingAncestorSync } from "@openclaw/fs-safe/advanced";

export function resolvePathViaExistingAncestorSync(
  targetPath: string,
  cache?: Map<string, string>,
): string {
  const cached = cache?.get(targetPath);
  if (cached !== undefined) {
    return cached;
  }
  const result = _resolvePathViaExistingAncestorSync(targetPath);
  cache?.set(targetPath, result);
  return result;
}

export {
  ROOT_PATH_ALIAS_POLICIES,
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
  type RootPathAliasPolicy,
} from "@openclaw/fs-safe/advanced";
