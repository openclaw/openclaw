import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet } from "../../agents/model-selection.js";
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
      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.local-gguf.unload": async ({ params, respond }) => {
    const modelPath = typeof params.modelPath === "string" ? params.modelPath : undefined;
    const all = params.all === true;

    if (!modelPath && !all) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "modelPath or all=true required"),
      );
      return;
    }

    try {
      const { LocalGgufModelManager } = await import("../../agents/local-gguf-manager.js");
      const manager = LocalGgufModelManager.getInstance();
      if (all) {
        await manager.clearCache();
        respond(true, { message: "All local GGUF models unloaded" }, undefined);
      } else if (modelPath) {
        await manager.unloadModel(modelPath);
        respond(true, { message: `Model unloaded: ${modelPath}` }, undefined);
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
