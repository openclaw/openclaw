import type { OpenClawConfig } from "../config/types.js";

/** Keeps authored provider IDs so callers can project canonical or execution aliases. */
export function listImageCapableConfiguredProviders(cfg?: OpenClawConfig): string[] {
  return Object.entries(cfg?.models?.providers ?? {})
    .filter(
      ([id, provider]) =>
        // Config-write secrets preflight reads source config before model defaults.
        id.trim() && (provider.models ?? []).some((model) => model.input?.includes("image")),
    )
    .map(([id]) => id);
}
