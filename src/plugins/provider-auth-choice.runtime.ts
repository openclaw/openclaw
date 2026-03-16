import {
  runProviderExplicitModelSelectedHook as runProviderExplicitModelSelectedHookImpl,
  resolveProviderPluginChoice as resolveProviderPluginChoiceImpl,
  runProviderModelSelectedHook as runProviderModelSelectedHookImpl,
} from "./provider-wizard.js";
import { resolvePluginProviders as resolvePluginProvidersImpl } from "./providers.runtime.js";

type ResolveProviderPluginChoice =
  typeof import("./provider-wizard.js").resolveProviderPluginChoice;
type RunProviderExplicitModelSelectedHook =
  typeof import("./provider-wizard.js").runProviderExplicitModelSelectedHook;
type RunProviderModelSelectedHook =
  typeof import("./provider-wizard.js").runProviderModelSelectedHook;
type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProviders;

export function resolveProviderPluginChoice(
  ...args: Parameters<ResolveProviderPluginChoice>
): ReturnType<ResolveProviderPluginChoice> {
  return resolveProviderPluginChoiceImpl(...args);
}

export function runProviderModelSelectedHook(
  ...args: Parameters<RunProviderModelSelectedHook>
): ReturnType<RunProviderModelSelectedHook> {
  return runProviderModelSelectedHookImpl(...args);
}

export function runProviderExplicitModelSelectedHook(
  ...args: Parameters<RunProviderExplicitModelSelectedHook>
): ReturnType<RunProviderExplicitModelSelectedHook> {
  return runProviderExplicitModelSelectedHookImpl(...args);
}

export function resolvePluginProviders(
  ...args: Parameters<ResolvePluginProviders>
): ReturnType<ResolvePluginProviders> {
  return resolvePluginProvidersImpl(...args);
}
