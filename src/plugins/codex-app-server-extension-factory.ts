import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type {
  PluginCodexAppServerExtensionFactoryRegistration,
  PluginRegistry,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export const CODEX_APP_SERVER_EXTENSION_RUNTIME_ID = "codex-app-server";

function listActiveCodexAppServerExtensionFactoryRegistrations(): readonly PluginCodexAppServerExtensionFactoryRegistration[] {
  const registry = getActivePluginRegistry() as PluginRegistry | null | undefined;
  if (!registry) {
    return [];
  }
  try {
    return Array.isArray(registry.codexAppServerExtensionFactories)
      ? registry.codexAppServerExtensionFactories
      : [];
  } catch {
    return [];
  }
}

function readCodexAppServerExtensionFactory(
  entry: PluginCodexAppServerExtensionFactoryRegistration,
): CodexAppServerExtensionFactory | undefined {
  try {
    const { factory } = entry;
    return typeof factory === "function" ? factory : undefined;
  } catch {
    return undefined;
  }
}

export function listCodexAppServerExtensionFactories(): CodexAppServerExtensionFactory[] {
  const factories: CodexAppServerExtensionFactory[] = [];
  for (const entry of listActiveCodexAppServerExtensionFactoryRegistrations()) {
    const factory = readCodexAppServerExtensionFactory(entry);
    if (factory) {
      factories.push(factory);
    }
  }
  return factories;
}
