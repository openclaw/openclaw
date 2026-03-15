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
      const { allowAny, allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      // When an explicit model allowlist is configured, use it. Otherwise
      // filter the full catalog to providers that have at least one auth
      // profile so the picker isn't overwhelmed with 600+ unconfigured models.
      let models: typeof catalog;
      if (!allowAny) {
        models = allowedCatalog;
      } else {
        const profiles = cfg?.auth?.profiles;
        const providerSet = new Set(
          Object.values(profiles ?? {})
            .map((p) => (p as { provider?: string }).provider)
            .filter(Boolean)
            .map((p) => normalizeProviderId(p as string)),
        );
        models =
          providerSet.size > 0
            ? catalog.filter((m) => providerSet.has(normalizeProviderId(m.provider)))
            : catalog;
      }
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
