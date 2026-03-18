import { AsyncLocalStorage } from "node:async_hooks";

export type PluginRuntimeCommandScope = {
  commandName: string;
  channel: string;
  gatewayClientScopes?: string[];
};

const PLUGIN_RUNTIME_COMMAND_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeCommandScope",
);

const pluginRuntimeCommandScope = (() => {
  const globalState = globalThis as typeof globalThis & {
    [PLUGIN_RUNTIME_COMMAND_SCOPE_KEY]?: AsyncLocalStorage<PluginRuntimeCommandScope>;
  };
  const existing = globalState[PLUGIN_RUNTIME_COMMAND_SCOPE_KEY];
  if (existing) {
    return existing;
  }
  const created = new AsyncLocalStorage<PluginRuntimeCommandScope>();
  globalState[PLUGIN_RUNTIME_COMMAND_SCOPE_KEY] = created;
  return created;
})();

export function withPluginRuntimeCommandScope<T>(
  scope: PluginRuntimeCommandScope,
  run: () => T,
): T {
  return pluginRuntimeCommandScope.run(scope, run);
}

export function getPluginRuntimeCommandScope(): PluginRuntimeCommandScope | undefined {
  return pluginRuntimeCommandScope.getStore();
}

export class PluginCommandScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginCommandScopeError";
  }
}

export function isPluginCommandScopeError(err: unknown): err is PluginCommandScopeError {
  return err instanceof PluginCommandScopeError;
}
