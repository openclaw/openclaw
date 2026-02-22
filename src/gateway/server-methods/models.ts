import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet, modelKey } from "../../agents/model-selection.js";
import { applyCustomApiConfig } from "../../commands/onboard-custom.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { defaultRuntime } from "../../runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
  validateModelsAddProviderParams,
} from "../protocol/index.js";
import { resetGatewayModelCatalogCache } from "../server-model-catalog.js";
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

  "models.addProvider": async ({ params, respond, context: _context }) => {
    if (!validateModelsAddProviderParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.addProvider params: ${formatValidationErrors(validateModelsAddProviderParams.errors)}`,
        ),
      );
      return;
    }

    try {
      const { baseUrl, apiKey, api, providerId, modelId, alias } = params as {
        baseUrl: string;
        apiKey?: string;
        api: "openai-completions" | "anthropic-messages";
        providerId: string;
        modelId: string;
        alias?: string;
      };

      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        const issues = snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`).join("\n");
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Invalid config:\n${issues}`),
        );
        return;
      }

      const compatibility = api === "anthropic-messages" ? "anthropic" : "openai";
      const result = applyCustomApiConfig({
        config: snapshot.config,
        baseUrl,
        apiKey,
        compatibility,
        providerId,
        modelId,
        alias,
      });

      await writeConfigFile(result.config);
      logConfigUpdated(defaultRuntime);

      // Clear model catalog cache so the new provider shows up immediately
      resetGatewayModelCatalogCache();

      const modelRef = modelKey(providerId, modelId);

      respond(true, {
        ok: true,
        providerId: result.providerId ?? providerId,
        modelId: result.modelId ?? modelId,
        modelRef,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
};
