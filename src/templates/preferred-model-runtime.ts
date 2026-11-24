import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolvePublishedModelCatalogOwner } from "../agents/prepared-model-catalog-owner.js";
import { withPreparedModelCatalogOwner } from "../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { resolveTemplatePreferredModel } from "./preferred-model.js";

/** Offline Add uses the same prepared, auth-aware model view as `models list`. */
export async function resolveLocalTemplatePreferredModel(
  requested: string,
  config: OpenClawConfig,
): Promise<string | undefined> {
  return resolveTemplatePreferredModel(requested, async () => {
    const agentId = resolveAmbientOwnerAgentId(config);
    return withPreparedModelCatalogOwner({ config, agentId, readOnly: true }, async (snapshot) => {
      const result = await buildModelsListResult({
        source: {
          kind: "published",
          owner: {
            ...resolvePublishedModelCatalogOwner(snapshot),
            authMaterializations: getPreparedModelRuntimeAuthMaterializations(snapshot),
          },
        },
        agentId,
        params: { includeDetails: true },
        includeManualSelection: true,
      });
      return result.models;
    });
  });
}
