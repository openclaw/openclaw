import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { getPluginCache, getPluginCacheRoot, type PluginCache } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRecord } from "./registry-types.js";
import { getPluginRegistryState } from "./runtime-state.js";
import {
  getPluginRegistryForContext,
  getPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";

function isSourceInsideRecordRoot(
  record: PluginRecord,
  rootDir: string,
  source: string,
  roots: PluginCache["runtimeRecordRoots"],
): boolean {
  if (process.platform === "win32" || !path.isAbsolute(rootDir)) {
    return isPathInside(rootDir, source);
  }
  // Only lexical facts are reusable; registry and captured-source membership stay live.
  let prepared = roots.get(record);
  if (prepared?.rootDir !== rootDir) {
    const resolvedRootDir = path.resolve(rootDir);
    prepared = {
      rootDir,
      resolvedRootDir,
      prefix: resolvedRootDir.endsWith(path.sep) ? resolvedRootDir : resolvedRootDir + path.sep,
    };
    roots.set(record, prepared);
  }
  return source === prepared.resolvedRootDir || source.startsWith(prepared.prefix);
}

/** Exact context identity disambiguates package siblings; a unique root works for host callers. */
export function resolvePluginRuntimeRecord(
  params: { pluginId?: string } & (
    | { pluginRoot: string; modulePath?: never }
    | { modulePath: string; pluginRoot?: never }
  ),
) {
  const root = params.pluginRoot ? getPluginCacheRoot(params.pluginRoot).rootDir : undefined;
  const source = params.modulePath ? path.resolve(params.modulePath) : undefined;
  const roots = getPluginCache().runtimeRecordRoots;
  const pluginId =
    params.pluginId ??
    getPluginRegistryState()?.registrationContext?.pluginId ??
    getPluginRuntimeGatewayRequestScope()?.pluginId;
  const records = getPluginRegistryForContext()?.plugins ?? [];
  const matchesSource = (record: PluginRecord) =>
    record.rootDir &&
    (root
      ? getPluginCacheRoot(record.rootDir).rootDir === root
      : isSourceInsideRecordRoot(record, record.rootDir, source!, roots) ||
        getPluginInstance(record)?.hasModuleSource(source!) === true);
  // Exact identity selects the first matching source owner, even for duplicate ids.
  // Keep membership live; an unmatched identity still needs the root ambiguity check.
  if (pluginId !== undefined) {
    const owner = records.find((record) => record.id === pluginId && matchesSource(record));
    if (owner) {
      return owner;
    }
  }
  let first: PluginRecord | undefined;
  let count = 0;
  for (const record of records) {
    // The completed synchronous identity pass already rejected every same-id source.
    if ((pluginId !== undefined && record.id === pluginId) || !matchesSource(record)) {
      continue;
    }
    first ??= record;
    count++;
  }
  if (count > 1 || (params.pluginId && count)) {
    throw new Error(
      `Plugin public surface ${root ?? source} has ambiguous runtime ownership; specify its plugin id.`,
    );
  }
  return first;
}
