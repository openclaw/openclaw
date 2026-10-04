import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { validateAgentsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveOperatorRolePolicy,
} from "../operator-role-policy.js";
import { listAgentsForGateway } from "../session-utils.js";
import { workerInferenceMetadata } from "../worker-environments/inference-placement.js";
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
  const result = await listAgentsForGateway(cfg, undefined, {
    modelCatalogByAgentId,
    includeSystem: hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.AGENT_KIND),
    httpAvatarBasePath:
      client?.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI
        ? (cfg.gateway?.controlUi?.basePath ?? "")
        : undefined,
  });
  const currentConfig = context.getRuntimeConfig();
  const roleError = authorizeCurrentOperatorRoleScopes(client, currentConfig);
  if (roleError) {
    respond(false, undefined, roleError);
    return;
  }
  const allowedAgents = resolveOperatorRolePolicy(client, currentConfig)?.agents;
  const agents =
    allowedAgents && allowedAgents !== "*"
      ? result.agents.filter((agent) => allowedAgents.includes(agent.id))
      : result.agents;
  const policy = prepareOperatorModelPresentation({
    cfg: currentConfig,
    policyConfig: context.getCommittedRuntimeConfig?.() ?? currentConfig,
    client,
  });
  const required = currentConfig.cloudWorkers?.requiredProfile;
  const profile = required ? currentConfig.cloudWorkers?.profiles?.[required] : undefined;
  // Keep legacy replies unchanged. This opt-in bootstrap fact grants no inventory or execution.
  const projected =
    params.includeSessionPlacement === true
      ? {
          ...result,
          sessionPlacement: required
            ? {
                requiredProfile: {
                  id: required,
                  ...(profile
                    ? {
                        providerId: profile.provider,
                        executionModes:
                          context.workerEnvironmentService?.supportsExecutionMode(
                            required,
                            "worker-turn",
                          ) === true
                            ? ["worker-turn" as const]
                            : [],
                        ...workerInferenceMetadata({
                          providerId: profile.provider,
                          profileSnapshot: profile,
                        }),
                      }
                    : {}),
                },
              }
            : {},
        }
      : result;
  respond(
    true,
    {
      ...projected,
      agents: policy
        ? agents.map((agent) =>
            policy.forAgent(agent.id, modelCatalogByAgentId.get(agent.id)?.entries).agent(agent),
          )
        : agents,
    },
    undefined,
  );
};
