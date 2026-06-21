// Gateway RPC handlers for image generation provider inventory.
import {
  ErrorCodes,
  errorShape,
  validateImageProvidersResult,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listImageGenerationProviders } from "../../image-generation/provider-registry.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Resolve active image provider from config.
 * Only returns a provider ID if it's explicitly configured in agents.defaults.imageGenerationModel.
 * No fallback to first configured or first listed provider.
 */
function resolveActiveImageProvider(cfg: OpenClawConfig, providerIds: string[]): string | null {
  const imageGenModel = cfg.agents?.defaults?.imageGenerationModel;
  if (!imageGenModel) return null;

  // Handle string format: "openai" or "openai/dall-e-3"
  const primaryId =
    typeof imageGenModel === "string"
      ? imageGenModel.split("/")[0]
      : imageGenModel.primary?.split("/")[0];

  if (!primaryId) return null;

  // Only return if the configured provider exists in the provider list
  return providerIds.includes(primaryId) ? primaryId : null;
}

/** Gateway request handlers for image generation provider inventory. */
export const imageHandlers: GatewayRequestHandlers = {
  "image.providers": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      // Use default agent directory for provider readiness checks (Finding 2)
      const agentDir = resolveDefaultAgentDir(cfg);

      const providers = listImageGenerationProviders(cfg).map((provider) => {
        // Use real provider readiness lookup (Finding 2)
        const isConfigured = provider.isConfigured?.({ cfg, agentDir }) ?? false;
        return {
          id: provider.id,
          label: provider.label ?? provider.id,
          configured: isConfigured,
          defaultModel: provider.defaultModel,
          models: provider.models ?? [],
          capabilities: {
            generate: provider.capabilities?.generate ?? { enabled: true },
            edit: provider.capabilities?.edit ?? { enabled: false },
            geometry: provider.capabilities?.geometry ?? false,
            output: provider.capabilities?.output ?? [],
          },
        };
      });

      // Only resolve active from config, no fallback invention (Finding 3)
      const providerIds = providers.map((p) => p.id);
      const active = resolveActiveImageProvider(cfg, providerIds);

      // Validate result before responding (Finding 4)
      const result = { providers, active };
      if (!validateImageProvidersResult(result)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid image.providers response: ${formatValidationErrors(validateImageProvidersResult.errors)}`,
          ),
        );
        return;
      }

      respond(true, result);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
