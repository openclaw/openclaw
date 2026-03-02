import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape, validateModelsListParams } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) {
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
      const models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
