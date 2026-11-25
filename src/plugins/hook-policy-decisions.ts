import type { PluginEntryConfig } from "../config/types.plugins.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type PluginHookPolicy = PluginEntryConfig["hooks"];

export function resolvePromptInjectionAllowed(policy?: PluginHookPolicy): boolean {
  return policy?.allowPromptModification !== false;
}

/**
 * Bundled plugins may read conversations unless denied. Other plugins need an explicit config
 * grant, or an approved capability review that included `contracts.conversationAccess`;
 * an explicit config value always wins.
 */
export function resolveConversationAccessAllowed(
  origin: PluginOrigin | "official",
  policy?: PluginHookPolicy,
  accepted?: boolean,
): boolean {
  const configured = policy?.allowConversationAccess;
  if (configured !== undefined) {
    return configured;
  }
  return origin === "bundled" || accepted === true;
}

/** Final provider request rewriting is never implied, even for bundled plugins. */
export function resolveModelRequestAllowed(policy?: PluginHookPolicy): boolean {
  return policy?.allowModelRequest === true;
}
