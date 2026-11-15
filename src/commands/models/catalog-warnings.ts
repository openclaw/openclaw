import type {
  ModelsListParams,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway, isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";

/** Shares model inventory's target selection without falling back across Gateways. */
export async function readSelectedGatewayModelCatalog(
  config: OpenClawConfig,
  params: ModelsListParams,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ModelsListResult | undefined> {
  signal?.throwIfAborted();
  const localTarget = await isImplicitLocalGatewayTarget({ config });
  const explicitPort = Boolean(process.env.OPENCLAW_GATEWAY_PORT?.trim());
  const owner =
    localTarget && !explicitPort
      ? await readActiveGatewayLockIdentity({ requireInspection: true })
      : undefined;
  signal?.throwIfAborted();
  if (localTarget && !explicitPort && !owner) {
    return undefined;
  }
  const result = await callGateway<ModelsListResult>({
    config,
    method: "models.list",
    ...(params.preparedOnly ? { sharedStateMode: "read-only" as const } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    requiredCapabilities: [GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG],
    ...(owner ? { localPortOverride: owner.port } : {}),
    params,
    signal,
  }).catch((error: unknown) => {
    signal?.throwIfAborted();
    throw error;
  });
  signal?.throwIfAborted();
  return result;
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
export async function readModelCatalog(
  config: OpenClawConfig,
  agentId?: string,
  signal?: AbortSignal,
) {
  return readSelectedGatewayModelCatalog(
    config,
    {
      view: "all",
      includeDetails: true,
      includeDefaultModels: true,
      preparedOnly: true,
      ...(agentId ? { agentId } : {}),
    },
    5000,
    signal,
  ).catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
}

/** The public read owns interruption; refresh must retain its admitted result. */
export async function runModelCatalogReadCommand(
  run: (signal?: AbortSignal) => Promise<void>,
  readOnly = true,
): Promise<void> {
  const signal = readOnly ? getAsyncWorkSignal() : undefined;
  try {
    signal?.throwIfAborted();
    await run(signal);
  } catch (error) {
    if (!signal?.aborted) {
      throw error;
    }
  }
}
