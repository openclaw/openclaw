import type { PluginProviderRuntimeAuthOverrideRegistration } from "./registry-types.js";

type ProviderRuntimeAuthOverrideGlobalState = {
  overrides: PluginProviderRuntimeAuthOverrideRegistration[];
};

const providerRuntimeAuthOverrideGlobalStateKey = Symbol.for(
  "openclaw.plugins.provider-runtime-auth-override-global-state",
);

function getState(): ProviderRuntimeAuthOverrideGlobalState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[providerRuntimeAuthOverrideGlobalStateKey] as
    | { overrides?: PluginProviderRuntimeAuthOverrideRegistration[] }
    | undefined;
  if (!existing || typeof existing !== "object") {
    const created: ProviderRuntimeAuthOverrideGlobalState = { overrides: [] };
    globalStore[providerRuntimeAuthOverrideGlobalStateKey] = created;
    return created;
  }
  if (!Array.isArray(existing.overrides)) {
    existing.overrides = [];
  }
  return existing as ProviderRuntimeAuthOverrideGlobalState;
}

export function setGlobalProviderRuntimeAuthOverrides(
  overrides: PluginProviderRuntimeAuthOverrideRegistration[],
): void {
  getState().overrides = overrides;
}

export function getGlobalProviderRuntimeAuthOverrides(): PluginProviderRuntimeAuthOverrideRegistration[] {
  return getState().overrides;
}

export function resetGlobalProviderRuntimeAuthOverridesForTest(): void {
  getState().overrides = [];
}
