import { createCapturedPluginRegistration } from "../../test-utils/plugin-registration.js";
import type { OpenClawPluginApi, ProviderPlugin } from "../types.js";

type RegistrablePlugin = {
  register(api: OpenClawPluginApi): void;
};

export function registerProviders(...plugins: RegistrablePlugin[]) {
  const captured = createCapturedPluginRegistration();
  for (const plugin of plugins) {
    plugin.register(captured.api);
  }
  return captured.providers;
}

export function requireProvider(providers: ProviderPlugin[], providerId: string) {
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`provider ${providerId} missing`);
  }
  return provider;
}

export function uniqueSortedStrings(values: readonly string[]) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
