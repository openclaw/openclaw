import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet, normalizeProviderId } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      const cfg = loadConfig();
      // Include providers from config AND providers with env-var API keys set
      // so implicitly authenticated providers also appear in the picker.
      const explicitProviders = Object.keys(cfg.models?.providers ?? {})
        .map((provider) => normalizeProviderId(provider.trim()))
        .filter(Boolean);

      const { PROVIDER_ENV_API_KEY_CANDIDATES } =
        await import("../../agents/model-auth-env-vars.js");
      const envProviders = Object.entries(PROVIDER_ENV_API_KEY_CANDIDATES)
        .filter(([, envVars]) => envVars.some((envVar) => process.env[envVar]))
        .map(([provider]) => normalizeProviderId(provider));

      const configuredProviders = new Set([...explicitProviders, ...envProviders]);
      const { allowAny, allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const hasConfiguredProviders = configuredProviders.size > 0;
      const providerScopedCatalog = hasConfiguredProviders
        ? catalog.filter((entry) =>
            configuredProviders.has(normalizeProviderId(entry.provider.trim())),
          )
        : catalog;
      const models = allowAny
        ? providerScopedCatalog.length > 0
          ? providerScopedCatalog
          : catalog
        : allowedCatalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
