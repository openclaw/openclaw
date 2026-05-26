import type { HookEntry } from "../hooks/types.js";
import type { PluginHookRegistration as TypedPluginHookRegistration } from "./hook-types.js";
import type { ReflexGateRegistration } from "./reflex-gates.js";

export type PluginLegacyHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};

export type HookRunnerRegistry = {
  hooks: PluginLegacyHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
  reflexGates?: ReflexGateRegistration[];
};

export type GlobalHookRunnerRegistry = HookRunnerRegistry & {
  plugins: Array<{
    id: string;
    status: "loaded" | "disabled" | "error";
  }>;
};
