import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
// Gateway RPC handlers for image generation provider inventory.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listImageGenerationProviders } from "../../image-generation/provider-registry.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Check if a provider has generic config (auth profile, model config, plugin config, or env var).
 * Reuses the same logic as CLI capability-cli.ts for consistency.
 */
function providerHasGenericConfig(cfg: OpenClawConfig, providerId: string): boolean {
  const modelsProviders = (cfg.models?.providers ?? {}) as Record<string, unknown>;
  const pluginEntries = (cfg.plugins?.entries ?? {}) as Record<string, { config?: unknown }>;
  const imageProviders = (cfg.agents?.defaults?.imageGenerationModel?.providers ?? {}) as Record<
    string,
    unknown
  >;
  return (
    // Has auth profile
    Object.keys(cfg.auth?.profiles ?? {}).some((key) => key.startsWith(providerId)) ||
    // Has model config
    Boolean(modelsProviders[providerId]) ||
    // Has plugin config
    Boolean(pluginEntries[providerId]?.config) ||
    // Has image model config
    Boolean(imageProviders[providerId])
  );
}

/** Gateway request handlers for image generation provider inventory. */
export const imageHandlers: GatewayRequestHandlers = {
  "image.providers": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      const providers = listImageGenerationProviders(cfg).map((provider) => {
        const isConfigured =
          provider.isConfigured?.({ cfg }) ?? providerHasGenericConfig(cfg, provider.id);
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
      // Find the first configured provider as active, or fallback to default
      const activeProvider = providers.find((p) => p.configured)?.id ?? providers[0]?.id ?? null;
      respond(true, {
        providers,
        active: activeProvider,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
