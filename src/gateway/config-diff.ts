// Config path diff helper used by gateway mutation diagnostics.
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPlainObject } from "../utils.js";

/** Return dotted config paths whose values differ between two config snapshots. */
export function diffConfigPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (prev === next) {
    return [];
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) {
        continue;
      }
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prevValue, nextValue, childPrefix);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Arrays can contain object entries (for example memory.qmd.paths/scope.rules);
    // compare structurally so identical values are not reported as changed.
    if (isDeepStrictEqual(prev, next)) {
      return [];
    }
  }
  return [prefix || "<root>"];
}

function diffPluginSecurityBoundaryPaths(
  prevConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): string[] {
  const prevEntries = prevConfig.plugins?.entries ?? {};
  const nextEntries = nextConfig.plugins?.entries ?? {};
  const ids = new Set([...Object.keys(prevEntries), ...Object.keys(nextEntries)]);
  const paths: string[] = [];
  for (const id of ids) {
    const prevEntry = prevEntries[id];
    const nextEntry = nextEntries[id];
    const entryPrefix = `plugins.entries.${id}`;
    paths.push(
      ...diffConfigPaths(
        { authorization: prevEntry?.authorization },
        { authorization: nextEntry?.authorization },
        entryPrefix,
      ),
    );
    const hasRequiredPolicy =
      (prevEntry?.authorization?.requiredPolicies?.length ?? 0) > 0 ||
      (nextEntry?.authorization?.requiredPolicies?.length ?? 0) > 0;
    if (hasRequiredPolicy && !isDeepStrictEqual(prevEntry, nextEntry)) {
      paths.push(`${entryPrefix}.authorization`);
    }
  }
  return [...new Set(paths)];
}

function diffPluginActivationPaths(
  prevConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): string[] {
  const project = (config: OpenClawConfig) => ({
    plugins: {
      enabled: config.plugins?.enabled,
      allow: config.plugins?.allow,
      deny: config.plugins?.deny,
      slots: config.plugins?.slots,
      bundledDiscovery: config.plugins?.bundledDiscovery,
    },
  });

  return diffConfigPaths(project(prevConfig), project(nextConfig));
}

/** Preserve startup-only restart boundaries hidden by whole-object config changes. */
export function diffGatewayReloadPaths(
  prevConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): string[] {
  const changedPaths = diffConfigPaths(prevConfig, nextConfig);
  const preservedPaths = [
    ...diffPluginSecurityBoundaryPaths(prevConfig, nextConfig),
    ...diffPluginActivationPaths(prevConfig, nextConfig),
  ];
  if (changedPaths.includes("plugins") || changedPaths.includes("plugins.entries")) {
    const prevEntries = prevConfig.plugins?.entries ?? {};
    const nextEntries = nextConfig.plugins?.entries ?? {};
    const ids = new Set([...Object.keys(prevEntries), ...Object.keys(nextEntries)]);
    for (const id of ids) {
      if (!isDeepStrictEqual(prevEntries[id], nextEntries[id])) {
        preservedPaths.push(`plugins.entries.${id}`);
      }
    }
  }
  if (changedPaths.includes("mcp")) {
    // Adding or removing the whole `mcp` object collapses to the broad `mcp`
    // path. Preserve the Apps boundary so the listener still restarts.
    preservedPaths.push(
      ...diffConfigPaths(
        { mcp: { apps: prevConfig.mcp?.apps } },
        { mcp: { apps: nextConfig.mcp?.apps } },
      ),
    );
  }
  return [...changedPaths, ...preservedPaths.filter((path) => !changedPaths.includes(path))];
}
