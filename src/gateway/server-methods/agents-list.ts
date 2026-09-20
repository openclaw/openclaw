import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { validateAgentsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { listAgentsForGateway } from "../session-utils.js";
import {
  readPreparedServerMethodModelCatalog,
  readPreparedServerMethodModelCatalogs,
} from "./optional-model-catalog.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentListHandler: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateAgentsListParams, "agents.list", respond)) {
    return;
  }

  const cfg = context.getRuntimeConfig();
  const agentIds = listAgentIds(cfg);
  const modelCatalogByAgentId = context.readPreparedGatewayModelCatalogBatch
    ? await readPreparedServerMethodModelCatalogs(context, agentIds)
    : new Map(
        await Promise.all(
          agentIds.map(
            async (agentId) =>
              [agentId, await readPreparedServerMethodModelCatalog(context, { agentId })] as const,
          ),
        ),
      );
  respond(
    true,
    await listAgentsForGateway(cfg, undefined, {
      modelCatalogByAgentId,
      includeSystem: hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.AGENT_KIND),
      httpAvatarBasePath:
        client?.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI
          ? (cfg.gateway?.controlUi?.basePath ?? "")
          : undefined,
    }),
    undefined,
  );
};
