import {
  ErrorCodes,
  errorShape,
  validateImageProvidersResult,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentDir } from "../../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../../agents/auth-profiles/store.js";
// Gateway RPC handlers for image generation provider inventory.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listImageGenerationProviders } from "../../image-generation/provider-registry.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Check if an object has own keys.
 * Mirrors src/cli/capability-cli.ts hasOwnKeys.
 */
function hasOwnKeys(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0,
  );
}

/**
 * Check if a provider has generic config (auth profile, model config, plugin config, TTS config).
 * Uses canonical loadAuthProfileStoreForRuntime for auth profile lookup.
 * Mirrors src/cli/capability-cli.ts providerHasGenericConfig.
 */
function providerHasGenericConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  agentDir: string;
}): boolean {
  const modelsProviders = (params.cfg.models?.providers ?? {}) as Record<string, unknown>;
  const pluginEntries = (params.cfg.plugins?.entries ?? {}) as Record<string, { config?: unknown }>;
  const ttsProviders = (params.cfg.messages?.tts?.providers ?? {}) as Record<string, unknown>;

  // Use canonical auth profile store loader
  const authStore = loadAuthProfileStoreForRuntime(params.agentDir);

  // Use delimiter matching to avoid prefix collision (e.g., openai vs openai-azure)
  const matchesProvider = (key: string): boolean =>
    key === params.providerId ||
    key.startsWith(params.providerId + ":") ||
    key.startsWith(params.providerId + "/");

  const hasAuthProfile = authStore
    ? Object.keys(authStore.profiles ?? {}).some(matchesProvider)
    : false;

  return (
    hasAuthProfile ||
    hasOwnKeys(modelsProviders[params.providerId]) ||
    hasOwnKeys(pluginEntries[params.providerId]?.config) ||
    hasOwnKeys(ttsProviders[params.providerId])
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
        // that uses canonical loadAuthProfileStoreForRuntime
        const providerConfigured = provider.isConfigured?.({ cfg, agentDir });
        const isConfigured =
          providerConfigured ??
          providerHasGenericConfig({
            cfg,
            providerId: provider.id,
            agentDir,
          });
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
      // Resolve active provider strictly from agents.defaults.imageGenerationModel.
      // Per ClawSweeper finding 3: do NOT fall back to first configured or first listed provider.
      // If config is absent or the configured provider is not in the providers list, return null.
      const configActive = resolveActiveImageProvider(cfg);
      const activeProvider =
        configActive && providers.some((p) => p.id === configActive) ? configActive : null;

      const result = { providers, active: activeProvider };
      // Validate response against protocol schema before returning
      if (!validateImageProvidersResult(result)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `image.providers response failed schema validation: ${formatValidationErrors(validateImageProvidersResult.errors)}`,
          ),
        );
        return;
      }
      respond(true, result);
    } catch (err) {
      // All errors return UNAVAILABLE (no INTERNAL_ERROR in ErrorCodes)
      const code = ErrorCodes.UNAVAILABLE;
      // Log detailed error internally, return generic message to client
      console.error("[image.providers] Error:", formatForLog(err));
      respond(false, undefined, errorShape(code, "Failed to retrieve image providers"));
    }
  },
};
