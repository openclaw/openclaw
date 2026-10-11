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
  const refinementPrefixes = new Set(reloadPrefixes);
  // Preserve individual plugin owners when the entries dictionary is added or removed.
  for (const config of [prevConfig, nextConfig]) {
    for (const pluginId of Object.keys(config.plugins?.entries ?? {})) {
      refinementPrefixes.add(`plugins.entries.${pluginId}`);
    }
  }
  const rosterPaths: string[] = [];
  if ((prevConfig.agents?.entries === undefined) !== (nextConfig.agents?.entries === undefined)) {
    rosterPaths.push("agents.entries");
  }
  const refineDecisionModel = refinementPrefixes.delete("agents.entries.*.decisionModel");
  for (const [config, other] of [
    [prevConfig, nextConfig],
    [nextConfig, prevConfig],
  ] as const) {
    for (const [agentId, agent] of Object.entries(config.agents?.entries ?? {})) {
      // Membership changes affect implicit workspace ownership even for empty entries.
      if (!Object.hasOwn(other.agents?.entries ?? {}, agentId)) {
        rosterPaths.push(`agents.entries.${agentId}`);
      }
      if (refineDecisionModel && agent.decisionModel !== undefined) {
        refinementPrefixes.add(`agents.entries.${agentId}.decisionModel`);
      }
    }
  }
  const changedPaths = diffConfigPaths(prevConfig, nextConfig, "", [...refinementPrefixes]);
  const boundaryPaths = diffConfigPaths(
    projectGatewayReloadBoundaries(prevConfig),
    projectGatewayReloadBoundaries(nextConfig),
  );
  // Effective Talk owners can change without an authored provider key changing.
  // Ordinary ownership boundaries are already preserved by the reload prefixes.
  return [
    ...changedPaths,
    ...[...rosterPaths, ...boundaryPaths].filter((path) => !changedPaths.includes(path)),
  ];
}
