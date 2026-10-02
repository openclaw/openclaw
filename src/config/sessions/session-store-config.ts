import fs from "node:fs";
import path from "node:path";
import { resolvePathPrefixSync, sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { tryResolvePathCaseInsensitive } from "../../infra/path-case.js";
import { resolveSessionStorePathCore } from "./paths.js";

function resolveMissingStorePathIdentity(pathname: string): string | undefined {
  try {
    const prefix = resolvePathPrefixSync(path.resolve(pathname));
    return path.resolve(prefix.existingPath, ...prefix.unresolvedSegments);
  } catch {
    return undefined;
  }
}

export function isPerAgentSessionStoreConfig(storeConfig: string | undefined): boolean {
  return !storeConfig?.trim() || storeConfig.includes("{agentId}");
}

export function isSameAuthoredSessionStoreConfig(
  source: string | undefined,
  target: string | undefined,
): boolean {
  return (!source?.trim() && !target?.trim()) || source === target;
}

export function isSameSessionStoreConfig(
  source: string | undefined,
  target: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (isPerAgentSessionStoreConfig(source) || isPerAgentSessionStoreConfig(target)) {
    return isSameAuthoredSessionStoreConfig(source, target);
  }
  return isSameFixedSessionStoreConfig(source, target, env);
}

export function isSameFixedSessionStoreConfig(
  source: string | undefined,
  target: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (isPerAgentSessionStoreConfig(source) || isPerAgentSessionStoreConfig(target)) {
    return false;
  }
  const sourcePath = path.resolve(resolveSessionStorePathCore(source, { env }));
  const targetPath = path.resolve(resolveSessionStorePathCore(target, { env }));
  if (sourcePath === targetPath) {
    return true;
  }
  try {
    return sameFileIdentity(
      fs.statSync(sourcePath, { bigint: true }),
      fs.statSync(targetPath, { bigint: true }),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      // An unresolved target may still alias the owned store. Treat that
      // ambiguity as owned so callers fail closed instead of admitting a writer.
      return true;
    }
  }

  const sourceIdentity = resolveMissingStorePathIdentity(sourcePath);
  const targetIdentity = resolveMissingStorePathIdentity(targetPath);
  if (!sourceIdentity || !targetIdentity) {
    return true;
  }
  if (sourceIdentity === targetIdentity) {
    return true;
  }
  if (sourceIdentity.toLowerCase() !== targetIdentity.toLowerCase()) {
    return false;
  }
  const sourceCaseInsensitive = tryResolvePathCaseInsensitive(sourceIdentity);
  const targetCaseInsensitive = tryResolvePathCaseInsensitive(targetIdentity);
  if (sourceCaseInsensitive === false || targetCaseInsensitive === false) {
    return false;
  }
  // Case-equivalent missing paths are owned when the filesystem folds case or
  // when probing cannot prove that the future paths will remain distinct.
  return true;
}
