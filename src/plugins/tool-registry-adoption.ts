import { isDeepStrictEqual } from "node:util";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { isPluginRecordActive, isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

type ScopeRegistrations = <T>(entries: readonly T[]) => T[];

/** A prepared tool and its complete hook suite share the live Gateway service owner. */
export function adoptRuntimeToolRegistrations(
  target: PluginRegistry,
  runtime: PluginRegistry,
  config: OpenClawConfig,
): PluginRegistry {
  const preparedConfig = getPluginRuntimeLoadContext(runtime)?.activationSourceConfig;
  if (!preparedConfig || isPluginRegistryRetired(target) || isPluginRegistryRetired(runtime)) {
    return target;
  }
  const sourceConfig = projectConfigOntoRuntimeSourceSnapshot(config);
  if (!isDeepStrictEqual(sourceConfig.hooks?.internal, preparedConfig.hooks?.internal)) {
    return target;
  }
  const replacements = new Map<PluginToolRegistration, PluginToolRegistration>();
  const hookOwners = new Map<string, ScopeRegistrations>();
  for (const pluginId of new Set(target.tools.map((entry) => entry.pluginId))) {
    const localRecord = target.plugins.find((record) => record.id === pluginId);
    const runtimeRecord = runtime.plugins.find((record) => record.id === pluginId);
    const local = localRecord && getPluginInstance(localRecord);
    const donor = runtimeRecord && getPluginInstance(runtimeRecord);
    if (
      localRecord?.status !== "loaded" ||
      !localRecord.enabled ||
      !runtimeRecord ||
      localRecord === runtimeRecord ||
      localRecord.source !== runtimeRecord.source ||
      localRecord.origin !== runtimeRecord.origin ||
      !local?.acceptingCalls ||
      !donor?.acceptingCalls ||
      !local.sourceDigest ||
      local.sourceDigest !== donor.sourceDigest ||
      !isPluginRecordActive(runtime, runtimeRecord) ||
      !isDeepStrictEqual(
        sourceConfig.plugins?.entries?.[pluginId]?.config,
        preparedConfig.plugins?.entries?.[pluginId]?.config,
      ) ||
      !isDeepStrictEqual(
        sourceConfig.plugins?.entries?.[pluginId]?.hooks,
        preparedConfig.plugins?.entries?.[pluginId]?.hooks,
      )
    ) {
      continue;
    }
    const locals = groupByDeclaredIdentity(target.tools, pluginId);
    const donors = groupByDeclaredIdentity(runtime.tools, pluginId, true);
    // Match complete selected registrations without adding donor-only tools.
    if (!locals || !donors) {
      continue;
    }
    if (
      [...locals].some(([identity, entries]) => donors.get(identity)?.length !== entries.length)
    ) {
      continue;
    }
    for (const [identity, entries] of locals) {
      const owned = donors.get(identity)!;
      entries.forEach((entry, index) => replacements.set(entry, owned[index]!));
    }
    // Donor handlers retain their native binding; the local wrapper also closes
    // hooks when the prepared consumer retires. Tools already capture both the
    // prepared registry authority and their donor factory's instance lifetime.
    hookOwners.set(pluginId, (entries) => entries.map((entry) => local.wrap(entry)));
  }
  if (replacements.size === 0) {
    return target;
  }
  return {
    ...target,
    tools: target.tools.map((entry) => replacements.get(entry) ?? entry),
    hooks: adoptHookPlane(target.hooks, runtime.hooks, hookOwners),
    typedHooks: adoptHookPlane(target.typedHooks, runtime.typedHooks, hookOwners),
    legacyInternalHooks: adoptHookPlane(
      target.legacyInternalHooks,
      runtime.legacyInternalHooks,
      hookOwners,
    ),
  };
}

/** Selected unnamed registrations cannot establish a comparable tool identity. */
function groupByDeclaredIdentity(
  tools: readonly PluginToolRegistration[],
  pluginId: string,
  skipUnnamed = false,
): Map<string, PluginToolRegistration[]> | undefined {
  const groups = new Map<string, PluginToolRegistration[]>();
  for (const entry of tools) {
    if (entry.pluginId !== pluginId) {
      continue;
    }
    const names = [...new Set(entry.names)].toSorted();
    if (names.length === 0) {
      if (skipUnnamed) {
        continue;
      }
      return undefined;
    }
    const declaredNames = entry.declaredNames ? [...entry.declaredNames].toSorted() : undefined;
    const identity = JSON.stringify([entry.contextVersion, entry.optional, names, declaredNames]);
    groups.set(identity, [...(groups.get(identity) ?? []), entry]);
  }
  return groups;
}

function adoptHookPlane<T extends { pluginId?: string }>(
  target: readonly T[],
  runtime: readonly T[],
  owners: ReadonlyMap<string, ScopeRegistrations>,
): T[] {
  const inserted = new Set<string>();
  const selected: T[] = [];
  const append = (pluginId: string, scope: ScopeRegistrations) => {
    inserted.add(pluginId);
    selected.push(...scope(runtime.filter((entry) => entry.pluginId === pluginId)));
  };
  for (const entry of target) {
    const pluginId = entry.pluginId;
    const scope = pluginId === undefined ? undefined : owners.get(pluginId);
    if (!scope || pluginId === undefined) {
      selected.push(entry);
    } else if (!inserted.has(pluginId)) {
      append(pluginId, scope);
    }
  }
  for (const [pluginId, scope] of owners) {
    if (!inserted.has(pluginId)) {
      append(pluginId, scope);
    }
  }
  return selected;
}
