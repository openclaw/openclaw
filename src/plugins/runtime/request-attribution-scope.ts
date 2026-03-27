import { AsyncLocalStorage } from "node:async_hooks";

export type PluginRuntimeRequestAttributionScope = {
  agentId?: string;
  sessionKey?: string;
};

const PLUGIN_RUNTIME_REQUEST_ATTRIBUTION_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeRequestAttributionScope",
);

const pluginRuntimeRequestAttributionScope = (() => {
  const globalState = globalThis as typeof globalThis & {
    [PLUGIN_RUNTIME_REQUEST_ATTRIBUTION_SCOPE_KEY]?: AsyncLocalStorage<PluginRuntimeRequestAttributionScope>;
  };
  const existing = globalState[PLUGIN_RUNTIME_REQUEST_ATTRIBUTION_SCOPE_KEY];
  if (existing) {
    return existing;
  }
  const created = new AsyncLocalStorage<PluginRuntimeRequestAttributionScope>();
  globalState[PLUGIN_RUNTIME_REQUEST_ATTRIBUTION_SCOPE_KEY] = created;
  return created;
})();

function normalizeScopeValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolvePluginRuntimeRequestAttributionScope(
  ctx: unknown,
): PluginRuntimeRequestAttributionScope | undefined {
  if (!ctx || typeof ctx !== "object") {
    return undefined;
  }
  const record = ctx as Record<string, unknown>;
  const agentId = normalizeScopeValue(record.agentId);
  const sessionKey = normalizeScopeValue(record.sessionKey);
  if (!agentId && !sessionKey) {
    return undefined;
  }
  return { agentId, sessionKey };
}

export function withPluginRuntimeRequestAttributionScope<T>(
  scope: PluginRuntimeRequestAttributionScope | undefined,
  run: () => T,
): T {
  if (!scope?.agentId && !scope?.sessionKey) {
    return run();
  }
  return pluginRuntimeRequestAttributionScope.run(scope, run);
}

export function getPluginRuntimeRequestAttributionScope():
  | PluginRuntimeRequestAttributionScope
  | undefined {
  return pluginRuntimeRequestAttributionScope.getStore();
}
