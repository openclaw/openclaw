// Config provider model helpers discover image-capable custom providers for
// media-understanding auto-registration.
import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";

/** Finds configured model providers that can be auto-registered for image understanding. */
export function resolveImageCapableConfigProviderIds(cfg?: OpenClawConfig): string[] {
  const configProviders = cfg?.models?.providers;
  if (!configProviders || typeof configProviders !== "object") {
    return [];
  }

  const providerIds: string[] = [];
  for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
    if (
      providerKey?.trim() &&
      (providerCfg.models ?? []).some(
        (model) => Array.isArray(model?.input) && model.input.includes("image"),
      )
    ) {
      providerIds.push(normalizeMediaProviderId(providerKey));
    }
  }
  return providerIds;
}
