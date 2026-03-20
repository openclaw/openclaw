import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet, resolveConfiguredModelRef } from "../../agents/model-selection.js";
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
      // Use the session's configured provider instead of the hardcoded DEFAULT_PROVIDER
      // so that non-anthropic model allowlists (e.g. minimax) are correctly filtered.
      const resolvedDefault = resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      const models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
