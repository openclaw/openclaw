// Config path diff helper used by gateway mutation diagnostics.
import { isDeepStrictEqual } from "node:util";
import * as talk from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPlainObject } from "../utils.js";

function collectConfigDiffPaths(
  prev: unknown,
  next: unknown,
  prefix: string,
  refinementPrefixes: readonly string[],
  paths: string[],
): void {
  if (prev === next) {
    return;
  }
  const prevIsPlainObject = isPlainObject(prev);
  const nextIsPlainObject = isPlainObject(next);
  // A missing parent normally collapses to one path. Registered boundaries must
  // survive that collapse so a narrow owner rule can still outrank its fallback.
  if (
    (prevIsPlainObject && nextIsPlainObject) ||
    ((prevIsPlainObject || nextIsPlainObject) &&
      refinementPrefixes.some((entry) => (prefix ? entry.startsWith(`${prefix}.`) : true)))
  ) {
    const prevRecord = prevIsPlainObject ? prev : {};
    const nextRecord = nextIsPlainObject ? next : {};
    const keys = new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)]);
    for (const key of keys) {
      const prevValue = prevRecord[key];
      const nextValue = nextRecord[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      collectConfigDiffPaths(prevValue, nextValue, childPrefix, refinementPrefixes, paths);
    }
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays can contain object entries (for example agent bindings);
    // compare structurally so identical values are not reported as changed.
    if (isDeepStrictEqual(prev, next)) {
      return;
    }
  }
  paths.push(prefix || "<root>");
}

/** Return dotted config paths whose values differ between two config snapshots. */
export function diffConfigPaths(
  prev: unknown,
  next: unknown,
  prefix = "",
  refinementPrefixes: readonly string[] = [],
): string[] {
  const paths: string[] = [];
  collectConfigDiffPaths(prev, next, prefix, refinementPrefixes, paths);
  return paths;
}

function projectGatewayReloadBoundaries(config: OpenClawConfig) {
  return {
    talk: {
      provider: talk.resolveConfiguredTalkSpeechProviderId(config),
      realtime: { provider: talk.resolveConfiguredTalkRealtimeProviderId(config) },
    },
  };
}

/** Preserve declared reload boundaries and derived capability-owner changes. */
export function diffGatewayReloadPaths(
  prevConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
  reloadPrefixes: Iterable<string>,
): string[] {
  const changedPaths = diffConfigPaths(prevConfig, nextConfig, "", [...reloadPrefixes]);
  const boundaryPaths = diffConfigPaths(
    projectGatewayReloadBoundaries(prevConfig),
    projectGatewayReloadBoundaries(nextConfig),
  );
  // Effective Talk owners can change without an authored provider key changing.
  // Ordinary ownership boundaries are already preserved by the reload prefixes.
  return [...changedPaths, ...boundaryPaths.filter((path) => !changedPaths.includes(path))];
}
