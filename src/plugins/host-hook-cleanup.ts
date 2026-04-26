import type { SessionEntry } from "../config/sessions.js";
import type { PluginHostCleanupReason } from "./host-hooks.js";
import type { PluginRegistry } from "./registry-types.js";

export type PluginHostCleanupFailure = {
  pluginId: string;
  hookId: string;
  error: unknown;
};

export type PluginHostCleanupResult = {
  cleanupCount: number;
  failures: PluginHostCleanupFailure[];
};

function shouldCleanPlugin(pluginId: string, filterPluginId?: string): boolean {
  return !filterPluginId || pluginId === filterPluginId;
}

export function clearPluginOwnedSessionState(entry: SessionEntry, pluginId?: string): void {
  if (!pluginId) {
    delete entry.pluginExtensions;
    delete entry.pluginNextTurnInjections;
    return;
  }
  if (entry.pluginExtensions) {
    delete entry.pluginExtensions[pluginId];
    if (Object.keys(entry.pluginExtensions).length === 0) {
      delete entry.pluginExtensions;
    }
  }
  if (entry.pluginNextTurnInjections) {
    delete entry.pluginNextTurnInjections[pluginId];
    if (Object.keys(entry.pluginNextTurnInjections).length === 0) {
      delete entry.pluginNextTurnInjections;
    }
  }
}

export async function runPluginHostCleanup(params: {
  registry?: PluginRegistry | null;
  pluginId?: string;
  reason: PluginHostCleanupReason;
  sessionKey?: string;
  runId?: string;
}): Promise<PluginHostCleanupResult> {
  const registry = params.registry;
  if (!registry) {
    return { cleanupCount: 0, failures: [] };
  }
  const failures: PluginHostCleanupFailure[] = [];
  let cleanupCount = 0;
  for (const registration of registry.sessionExtensions ?? []) {
    if (!shouldCleanPlugin(registration.pluginId, params.pluginId)) {
      continue;
    }
    const cleanup = registration.extension.cleanup;
    if (!cleanup) {
      continue;
    }
    try {
      await cleanup({
        reason: params.reason,
        sessionKey: params.sessionKey,
      });
      cleanupCount += 1;
    } catch (error) {
      failures.push({
        pluginId: registration.pluginId,
        hookId: `session:${registration.extension.namespace}`,
        error,
      });
    }
  }
  for (const registration of registry.runtimeLifecycles ?? []) {
    if (!shouldCleanPlugin(registration.pluginId, params.pluginId)) {
      continue;
    }
    const cleanup = registration.lifecycle.cleanup;
    if (!cleanup) {
      continue;
    }
    try {
      await cleanup({
        reason: params.reason,
        sessionKey: params.sessionKey,
        runId: params.runId,
      });
      cleanupCount += 1;
    } catch (error) {
      failures.push({
        pluginId: registration.pluginId,
        hookId: `runtime:${registration.lifecycle.id}`,
        error,
      });
    }
  }
  return { cleanupCount, failures };
}

function collectHostHookPluginIds(registry: PluginRegistry): Set<string> {
  const ids = new Set<string>();
  for (const registration of registry.sessionExtensions ?? []) {
    ids.add(registration.pluginId);
  }
  for (const registration of registry.runtimeLifecycles ?? []) {
    ids.add(registration.pluginId);
  }
  return ids;
}

function collectLoadedPluginIds(registry: PluginRegistry): Set<string> {
  return new Set(
    registry.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id),
  );
}

export async function cleanupReplacedPluginHostRegistry(params: {
  previousRegistry?: PluginRegistry | null;
  nextRegistry?: PluginRegistry | null;
}): Promise<PluginHostCleanupResult> {
  const previousRegistry = params.previousRegistry;
  if (!previousRegistry || previousRegistry === params.nextRegistry) {
    return { cleanupCount: 0, failures: [] };
  }
  const nextPluginIds = params.nextRegistry
    ? collectLoadedPluginIds(params.nextRegistry)
    : new Set();
  const previousHostPluginIds = collectHostHookPluginIds(previousRegistry);
  const failures: PluginHostCleanupFailure[] = [];
  let cleanupCount = 0;
  for (const pluginId of previousHostPluginIds) {
    const result = await runPluginHostCleanup({
      registry: previousRegistry,
      pluginId,
      reason: nextPluginIds.has(pluginId) ? "restart" : "disable",
    });
    cleanupCount += result.cleanupCount;
    failures.push(...result.failures);
  }
  return { cleanupCount, failures };
}
