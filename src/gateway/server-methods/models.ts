import type { GatewayRequestHandlers } from "./types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/io.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";

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
      const allowed = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });

      let models;
      if (allowed.allowAny) {
        // No allowlist configured — return full catalog.
        models = catalog;
      } else {
        // Start with catalog entries that are in the allowlist.
        const out = [...allowed.allowedCatalog];
        const seen = new Set(out.map((e) => `${e.provider}/${e.id}`));
        // Add allowlist entries that aren't in the built-in catalog
        // (e.g. custom providers from models.providers).
        for (const key of allowed.allowedKeys) {
          if (seen.has(key)) {
            continue;
          }
          const slash = key.indexOf("/");
          if (slash <= 0) {
            continue;
          }
          const provider = key.slice(0, slash);
          const id = key.slice(slash + 1);
          out.push({ provider, id, name: id });
          seen.add(key);
        }
        models = out;
      }
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
