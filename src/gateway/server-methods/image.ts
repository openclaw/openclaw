import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
// Gateway RPC handlers for image generation provider inventory.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listImageGenerationProviders } from "../../image-generation/provider-registry.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Check if a provider has generic config (auth profile, model config, plugin config).
 * Reuses the same logic as CLI capability-cli.ts for consistency.
 */
function providerHasGenericConfig(
  cfg: OpenClawConfig,
  providerId: string,
  agentDir?: string,
): boolean {
  const modelsProviders = (cfg.models?.providers ?? {}) as Record<string, unknown>;
  const pluginEntries = (cfg.plugins?.entries ?? {}) as Record<string, { config?: unknown }>;
  return (
    // Has auth profile
    Object.keys(cfg.auth?.profiles ?? {}).some((key) => key.startsWith(providerId)) ||
    // Has model config
    Boolean(modelsProviders[providerId]) ||
    // Has plugin config
    Boolean(pluginEntries[providerId]?.config)
  );
}

/**
 * Resolve the active image generation provider from config.
 * Uses agents.defaults.imageGenerationModel.primary if set.
 */
function resolveActiveImageProvider(cfg: OpenClawConfig): string | null {
  const imageConfig = cfg.agents?.defaults?.imageGenerationModel;
  if (!imageConfig) return null;

  // Handle string format like "openai" or "openai/dall-e-3"
  if (typeof imageConfig === "string") {
    const [providerId] = imageConfig.split("/");
    return providerId || imageConfig;
  }

  // Handle object format with primary field
  const primary = imageConfig.primary;
  if (primary) {
    const [providerId] = primary.split("/");
    return providerId || primary;
  }

  return null;
}

/** Gateway request handlers for image generation provider inventory. */
export const imageHandlers: GatewayRequestHandlers = {
  "image.providers": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      const agentDir = context.agentDir;

      const providers = listImageGenerationProviders(cfg).map((provider) => {
        // Use provider's isConfigured with agentDir if available, otherwise fallback to generic config check
        const isConfigured =
          provider.isConfigured?.({ cfg, agentDir }) ??
          providerHasGenericConfig(cfg, provider.id, agentDir);
        return {
          id: provider.id,
          label: provider.label ?? provider.id,
          configured: isConfigured,
          defaultModel: provider.defaultModel,
          models: provider.models ?? [],
          capabilities: {
            generate: provider.capabilities?.generate ?? true,
            edit: provider.capabilities?.edit ?? false,
            geometry: provider.capabilities?.geometry ?? false,
            output: provider.capabilities?.output ?? [],
          },
        };
      });
      // Use config primary as active, fallback to first configured provider, then first provider
      const configActive = resolveActiveImageProvider(cfg);
      const activeProvider =
        (configActive && providers.find((p) => p.id === configActive && p.configured))?.id ??
        providers.find((p) => p.configured)?.id ??
        providers[0]?.id ??
        null;
      respond(true, {
        providers,
        active: activeProvider,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
