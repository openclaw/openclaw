/** Reads the selected Gateway catalog or an explicitly identified local published view. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelsListParams } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { ExpectedCliError } from "../../cli/expected-cli-error.js";
import { runWithLocalStateOwner } from "../../cli/local-state-owner.js";
import { requestExitAfterOneShotOutput } from "../../cli/one-shot-exit.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { startProxy, stopProxy } from "../../infra/net/proxy/proxy-lifecycle.js";
import { type RuntimeEnv, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { getModelCatalogWarnings, readSelectedGatewayModelCatalog } from "./catalog-warnings.js";
import { formatTokenK, isRich, padTerminalCell, truncate } from "./list.format.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfig } from "./load-config.js";
import { ensureFlagCompatibility, resolveModelsTargetAgent } from "./shared.js";

// The catalog worker permits three minutes; leave room for connection and result projection.
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 210_000;

const MODEL_PAD = 42;
const INPUT_PAD = 10;
const CTX_PAD = 11;
const STATE_PAD = 5;

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
  const cfg = await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })();
  const params: ModelsListParams = {
    ...(opts.agent?.trim() ? { agentId: opts.agent.trim() } : {}),
    view: opts.all || provider ? "all" : "default",
    ...(provider ? { provider } : {}),
    includeDetails: true,
    ...(opts.refresh ? { refresh: true } : {}),
  };
  let result = await readSelectedGatewayModelCatalog(
    cfg,
    params,
    opts.refresh ? MODEL_CATALOG_REFRESH_TIMEOUT_MS : undefined,
  );
  if (!result) {
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
    const readLocal = async (refreshOwner?: {
      env: NodeJS.ProcessEnv;
      signal: AbortSignal;
      assertCurrent: () => void;
    }) => {
      const localConfig = await loadModelsConfig({
        commandName: "models list",
        runtime,
      });
      const { agentId, agentDir } = resolveModelsTargetAgent(localConfig, opts.agent, {
        kind: "read",
      });
      if (refreshOwner) {
        const [
          { prepareOpenClawAgentDatabaseExecution },
          { resolveAuthProfileDatabasePath },
          { prepareLocalCapabilityAccountSecrets },
        ] = await Promise.all([
          import("../../state/openclaw-agent-execution.js"),
          import("../../agents/auth-profiles/sqlite.js"),
          import("../../cli/capability-cli/local-account-secrets.js"),
        ]);
        // Prepare the catalog's writable store before secrets observe its initial file identity.
        await prepareOpenClawAgentDatabaseExecution(
          { agentId, path: resolveAuthProfileDatabasePath(agentDir), env: refreshOwner.env },
          refreshOwner.assertCurrent,
          refreshOwner.signal,
        );
        await prepareLocalCapabilityAccountSecrets({ cfg: localConfig, agentId });
        refreshOwner.assertCurrent();
      }
      const proxy = opts.refresh ? await startProxy(localConfig.proxy) : null;
      try {
        return await withPreparedModelCatalogOwner(
          {
            agentId,
            agentDir,
            config: localConfig,
            readOnly: opts.refresh !== true,
            ...(opts.refresh ? { refreshFullCatalog: true, persistOfflineRefresh: true } : {}),
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
      } finally {
        await stopProxy(proxy);
      }
    };
    result = opts.refresh
      ? await runWithLocalStateOwner({
          method: "models.list",
          params,
          target: "local model catalog",
          onForeignOwner: "refuse",
          runLocal: async (owner) => {
            const refreshed = await readLocal(owner);
            owner.assertCurrent();
            return refreshed;
          },
        })
      : await readLocal();
  }
  for (const warning of getModelCatalogWarnings(result)) {
    runtime.error(`${warning.message} ${warning.fixHint}`);
  }
  if (result.refreshFailed) {
    runtime.error(
      "Model discovery could not refresh all providers. Showing the available published model list.",
    );
  }
  for (const outcome of result.providerOutcomes ?? []) {
    if (outcome.status === "ready") {
      continue;
    }
    const label = `${sanitizeTerminalText(outcome.provider)}${outcome.profileId ? ` (profile ${sanitizeTerminalText(outcome.profileId)})` : ""}`;
    runtime.error(
      outcome.status === "auth-rejected"
        ? `Model discovery authentication was rejected for ${label}. Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.`
        : `Model discovery is unavailable for ${label}. Retry with --refresh; if it still fails, check the provider in Models in the Control UI.`,
    );
  }
  const rows = result.models
    .filter((model) => !opts.local || model.local === true)
    .map((model): ModelRow => ({
      key: modelKey(model.provider, model.id),
      name: model.name,
      input: model.input?.join("+") || "-",
      contextWindow: model.contextWindow ?? null,
      contextTokens: model.contextTokens,
      local: model.local ?? null,
      available: model.available ?? null,
      tags: [...new Set([...(model.tags ?? []), ...(model.alias ? [`alias:${model.alias}`] : [])])],
    }));
  if (rows.length === 0 && !opts.json && !opts.plain) {
    runtime.log("No models found.");
  } else if (opts.json) {
    const providerOutcomes = result.providerOutcomes?.map(
      ({ provider: outcomeProvider, profileId, status, unlistedConfiguredModelIds }) => ({
        provider: outcomeProvider,
        profileId: profileId || undefined,
        status,
        unlistedConfiguredModelIds:
          status === "ready" && unlistedConfiguredModelIds?.length
            ? unlistedConfiguredModelIds
            : undefined,
      }),
    );
    writeRuntimeJson(runtime, {
      count: rows.length,
      models: rows,
      ...(providerOutcomes?.length ? { providerOutcomes } : {}),
    });
  } else if (opts.plain) {
    for (const row of rows) {
      writeRuntimeStdout(runtime, sanitizeTerminalText(row.key));
    }
  } else {
    const rich = isRich(opts);
    const formatRowTag = rich
      ? (rawTag: string) => {
          const tag = sanitizeTerminalText(rawTag);
          switch (tag) {
            case "default":
              return theme.success(tag);
            case "image":
              return theme.accentBright(tag);
            case "configured":
              return theme.accent(tag);
            case "missing":
              return theme.error(tag);
          }
          if (tag.startsWith("fallback#") || tag.startsWith("img-fallback#")) {
            return theme.warn(tag);
          }
          if (tag.startsWith("alias:")) {
            return theme.accentDim(tag);
          }
          return theme.muted(tag);
        }
      : sanitizeTerminalText;
    const formatState = (value: boolean | null, unavailableColor = theme.muted) =>
      colorize(
        rich,
        value === null ? theme.muted : value ? theme.success : unavailableColor,
        padTerminalCell(value === null ? "-" : value ? "yes" : "no", STATE_PAD),
      );
    const header = [
      padTerminalCell("Model", MODEL_PAD),
      padTerminalCell("Input", INPUT_PAD),
      padTerminalCell("Ctx", CTX_PAD),
      padTerminalCell("Local", STATE_PAD),
      padTerminalCell("Auth", STATE_PAD),
      "Tags",
    ].join(" ");
    runtime.log(rich ? theme.heading(header) : header);

    for (const row of rows) {
      const keyLabel = padTerminalCell(truncate(row.key, MODEL_PAD), MODEL_PAD);
      const coloredInput = colorize(
        rich,
        row.input.includes("image") ? theme.accentBright : theme.info,
        padTerminalCell(sanitizeTerminalText(row.input) || "-", INPUT_PAD),
      );

      const contextLabel =
        typeof row.contextTokens === "number" &&
        Number.isFinite(row.contextTokens) &&
        row.contextTokens > 0 &&
        row.contextTokens !== row.contextWindow
          ? `${formatTokenK(row.contextTokens)}/${formatTokenK(row.contextWindow)}`
          : formatTokenK(row.contextWindow);
      const line = [
        rich ? theme.accent(keyLabel) : keyLabel,
        coloredInput,
        padTerminalCell(contextLabel, CTX_PAD),
        formatState(row.local),
        formatState(row.available, theme.error),
        row.tags.map(formatRowTag).join(","),
      ].join(" ");
      runtime.log(line);
    }
  }
  requestExitAfterOneShotOutput(runtime);
}
