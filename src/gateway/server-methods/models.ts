import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet, filterModelCatalog } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import type { GatewayControlUiModelSelectorFilter } from "../../config/types.gateway.js";
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
      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const baseCatalog = allowedCatalog.length > 0 ? allowedCatalog : catalog;

      const filter: GatewayControlUiModelSelectorFilter =
        (params as { filter?: GatewayControlUiModelSelectorFilter }).filter ??
        cfg.gateway?.controlUi?.modelSelector?.filter ??
        "all";

      const models = filterModelCatalog({
        catalog: baseCatalog,
        cfg,
        filter,
        defaultProvider: DEFAULT_PROVIDER,
      });

      respond(
        true,
        {
          models,
          _meta: {
            totalCount: baseCatalog.length,
            filteredCount: models.length,
            filterMode: filter,
          },
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
