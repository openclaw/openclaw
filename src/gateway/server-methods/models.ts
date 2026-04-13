import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet } from "../../agents/model-selection.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
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

      const effectiveCatalog = (() => {
        if (cfg.models?.mode !== "replace") {
          return catalog;
        }
        const configuredProviders = cfg.models?.providers;
        if (!configuredProviders || typeof configuredProviders !== "object") {
          return catalog;
        }
        const providerKeys = new Set(
          Object.keys(configuredProviders).map((provider) => normalizeProviderId(provider.trim())),
        );
        if (providerKeys.size === 0) {
          return catalog;
        }
        return catalog.filter((entry) =>
          providerKeys.has(normalizeProviderId(entry.provider.trim())),
        );
      })();

      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog: effectiveCatalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const models = allowedCatalog.length > 0 ? allowedCatalog : effectiveCatalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
