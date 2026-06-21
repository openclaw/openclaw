import {
  ErrorCodes,
  errorShape,
  validateImageProvidersResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentDir } from "../../agents/agent-scope.js";
// Gateway RPC handlers for image generation provider inventory.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listImageGenerationProviders } from "../../image-generation/provider-registry.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Check if a provider has generic config (auth profile, model config, plugin config).
 * This function only checks cfg-internal fields, does not read disk.
 * Mirrors the pattern in src/cli/capability-cli.ts for consistency.
 */
function providerHasGenericConfig(cfg: OpenClawConfig, providerId: string): boolean {
  const modelsProviders = (cfg.models?.providers ?? {}) as Record<string, unknown>;
  const pluginEntries = (cfg.plugins?.entries ?? {}) as Record<string, { config?: unknown }>;
  // Use delimiter matching to avoid prefix collision (e.g., openai vs openai-azure)
  const matchesProvider = (key: string): boolean =>
    key === providerId || key.startsWith(providerId + ":") || key.startsWith(providerId + "/");
  return (
    // Has auth profile
    Object.keys(cfg.auth?.profiles ?? {}).some(matchesProvider) ||
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
      // Use default agent directory for provider readiness checks
      const agentDir = resolveDefaultAgentDir(cfg);

      const providers = listImageGenerationProviders(cfg).map((provider) => {
        // Use provider's isConfigured with agentDir, fallback to generic config check
        const isConfigured =
          provider.isConfigured?.({ cfg, agentDir }) ?? providerHasGenericConfig(cfg, provider.id);
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

      const result = { providers, active: activeProvider };
      // Validate response against protocol schema before returning
      const validation = validateImageProvidersResult(result);
      if (!validation.success) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_PARAMS,
            `image.providers response failed schema validation: ${validation.error?.message ?? ""}`,
          ),
        );
        return;
      }
      respond(true, result);
    } catch (err) {
      // Classify error by type for appropriate response code
      const errorMessage = err instanceof Error ? err.message : String(err);
      let code = ErrorCodes.UNAVAILABLE;
      // Distinguish config errors from runtime errors
      if (errorMessage.includes("config") || errorMessage.includes("Config")) {
        code = ErrorCodes.INVALID_PARAMS;
      } else if (errorMessage.includes("registry") || errorMessage.includes("Registry")) {
        code = ErrorCodes.UNAVAILABLE;
      } else {
        code = ErrorCodes.INTERNAL_ERROR;
      }
      // Log detailed error internally, return generic message to client
      console.error("[image.providers] Error:", formatForLog(err));
      respond(false, undefined, errorShape(code, "Failed to retrieve image providers"));
    }
  },
};
