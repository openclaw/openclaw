import type {
  ModelsListParams,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway, isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";

/** Shares model inventory's target selection without falling back across Gateways. */
export async function readSelectedGatewayModelCatalog(
  config: OpenClawConfig,
  params: ModelsListParams,
  timeoutMs?: number,
): Promise<ModelsListResult | undefined> {
  const localTarget = await isImplicitLocalGatewayTarget({ config });
  const explicitPort = Boolean(process.env.OPENCLAW_GATEWAY_PORT?.trim());
  const owner =
    localTarget && !explicitPort
      ? await readActiveGatewayLockIdentity({ requireInspection: true })
      : undefined;
  if (localTarget && !explicitPort && !owner) {
    return undefined;
  }
  return callGateway<ModelsListResult>({
    config,
    method: "models.list",
    ...(params.preparedOnly ? { sharedStateMode: "read-only" as const } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    requiredCapabilities: [GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG],
    ...(owner ? { localPortOverride: owner.port } : {}),
    params,
  });
}

export function getModelCatalogWarnings(result: ModelsListResult | undefined) {
  return (
    result?.providerOutcomes?.flatMap((outcome) =>
      outcome.status === "ready"
        ? (outcome.unlistedConfiguredModelIds ?? []).map((modelId) => ({
            ref: `${outcome.provider}/${modelId}`,
            message: `Configured model "${sanitizeTerminalText(`${outcome.provider}/${modelId}`)}" is not present in the provider's last successful server catalog${outcome.profileId ? ` (profile ${sanitizeTerminalText(outcome.profileId)})` : ""}.`,
            fixHint:
              "Pull or download it on that server, or fix the configured model name; then run openclaw models list --refresh. The model remains selectable.",
          }))
        : [],
    ) ?? []
  );
}

/** Diagnostic reads consume a prepared publication; they never discover or probe providers. */
export async function readModelCatalog(config: OpenClawConfig, agentId?: string) {
  return readSelectedGatewayModelCatalog(
    config,
    { view: "all", includeDetails: true, preparedOnly: true, ...(agentId ? { agentId } : {}) },
    5000,
  ).catch(() => undefined);
}
