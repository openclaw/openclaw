/** Reads the selected Gateway catalog or an explicitly identified local published view. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelsListParams,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { ExpectedCliError } from "../../cli/failure-output.js";
import { requestExitAfterOneShotOutput } from "../../cli/one-shot-exit.js";
import { getRuntimeConfig } from "../../config/config.js";
import { callGateway, isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import type { RuntimeEnv } from "../../runtime.js";
import { ensureFlagCompatibility } from "./list.options.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { resolveModelsTargetAgent } from "./shared.js";

// The catalog worker permits three minutes; leave room for connection and result projection.
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 210_000;

function toCliModelRow(model: ModelChoice): ModelRow {
  return {
    key: modelKey(model.provider, model.id),
    name: model.name,
    input: model.input?.join("+") || "-",
    contextWindow: model.contextWindow ?? null,
    ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    local: model.local ?? null,
    available: model.available ?? null,
    tags: [...new Set([...(model.tags ?? []), ...(model.alias ? [`alias:${model.alias}`] : [])])],
  };
}

export async function modelsListCommand(
  opts: {
    all?: boolean;
    refresh?: boolean;
    local?: boolean;
    provider?: string;
    agent?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const rawProvider = opts.provider?.trim();
  if (rawProvider && /\s/u.test(rawProvider)) {
    const message = `Invalid provider filter "${sanitizeTerminalText(rawProvider)}". Use a provider id such as "moonshot", not a display label.`;
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }
  const provider = rawProvider ? normalizeProviderId(rawProvider) : undefined;
  // Gateway selection needs connection config, not local provider credentials or plugins.
  const cfg = getRuntimeConfig({ skipPluginValidation: true });
  const params: ModelsListParams = {
    ...(opts.agent?.trim() ? { agentId: opts.agent.trim() } : {}),
    view: opts.all || provider ? "all" : "default",
    ...(provider ? { provider } : {}),
    includeDetails: true,
    ...(opts.refresh ? { refresh: true } : {}),
  };
  const localTarget = await isImplicitLocalGatewayTarget({ config: cfg });
  const explicitPort = Boolean(process.env.OPENCLAW_GATEWAY_PORT?.trim());
  const gatewayOwner =
    localTarget && !explicitPort
      ? await readActiveGatewayLockIdentity({ requireInspection: true })
      : undefined;
  let result: ModelsListResult;
  if (!localTarget || explicitPort || gatewayOwner) {
    // Once selected, this Gateway owns both success and failure. Never replace a failed
    // connection or unsupported capability with a different local inventory.
    result = await callGateway<ModelsListResult>({
      config: cfg,
      method: "models.list",
      ...(opts.refresh ? { timeoutMs: MODEL_CATALOG_REFRESH_TIMEOUT_MS } : {}),
      requiredCapabilities: [GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG],
      ...(gatewayOwner ? { localPortOverride: gatewayOwner.port } : {}),
      params,
    });
  } else {
    runtime.error(
      opts.refresh
        ? "Gateway is not running. Refreshing the local model catalog."
        : "Gateway is not running. Showing the local cached model catalog. Use --refresh to discover provider models.",
    );
    const [
      { resolvePublishedModelCatalogOwner },
      { withPreparedModelCatalogOwner },
      { getPreparedModelRuntimeAuthMaterializations },
      { buildModelsListResult },
    ] = await Promise.all([
      import("../../agents/prepared-model-catalog-owner.js"),
      import("../../agents/prepared-model-catalog.js"),
      import("../../agents/prepared-model-runtime-auth.js"),
      import("../../gateway/server-methods/models-list-result.js"),
    ]);
    const { resolvedConfig: localConfig } = await loadModelsConfigWithSource({
      commandName: "models list",
      runtime,
    });
    const { agentId, agentDir } = resolveModelsTargetAgent(localConfig, opts.agent, {
      kind: "read",
    });
    result = await withPreparedModelCatalogOwner(
      {
        agentId,
        agentDir,
        config: localConfig,
        readOnly: opts.refresh !== true,
        ...(opts.refresh ? { refreshFullCatalog: true } : {}),
      },
      async (snapshot) => {
        const owner = resolvePublishedModelCatalogOwner(snapshot);
        // Complete row projection and its final readiness reads before releasing a temporary owner.
        return await buildModelsListResult({
          source: {
            kind: "published",
            owner: {
              ...owner,
              authMaterializations: getPreparedModelRuntimeAuthMaterializations(snapshot),
            },
          },
          agentId,
          params,
        });
      },
    );
  }
  if (opts.refresh && result.providerOutcomes?.some((outcome) => outcome.status !== "ready")) {
    runtime.error(
      "Model discovery could not refresh all providers. Showing the available published model list.",
    );
  }
  const rows = result.models
    .filter((model) => !opts.local || model.local === true)
    .map(toCliModelRow);
  if (rows.length === 0 && !opts.json && !opts.plain) {
    runtime.log("No models found.");
  } else {
    printModelTable(rows, runtime, opts);
  }
  requestExitAfterOneShotOutput(runtime);
}
