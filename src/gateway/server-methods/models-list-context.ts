import type { ModelsListParams } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { RuntimeAuthMaterialization } from "../../agents/auth-profiles/runtime-materializations.js";
import type { ResolvedPublishedModelCatalogOwner } from "../../agents/prepared-model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import type { GatewayRequestContext } from "./shared-types.js";

export type GatewayModelCatalogContext = Pick<
  GatewayRequestContext,
  "getRuntimeConfig" | "loadGatewayModelCatalogSnapshot"
> & {
  logGateway: Pick<GatewayRequestContext["logGateway"], "debug">;
};

export type ModelsListCatalogSource =
  | { kind: "gateway"; context: GatewayModelCatalogContext }
  | {
      kind: "published";
      getConfig?: () => OpenClawConfig;
      owner: ResolvedPublishedModelCatalogOwner & {
        authMaterializations: readonly RuntimeAuthMaterialization[];
      };
    };

export type PreparedModelsListRequest = {
  agentId: string;
  params: ModelsListParams;
  includeManualSelection?: boolean;
  requesterProfileId?: string;
  readScope?: ChatMetadataReadParams;
};
