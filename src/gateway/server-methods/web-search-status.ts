import type {
  WebSearchStatusParams,
  WebSearchStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { AUTH_STORE_VERSION } from "../../agents/auth-profiles/constants.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "../../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { BUILTIN_AGENT_HARNESS_METADATA } from "../../agents/harness/builtin-openclaw-metadata.js";
import {
  createModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "../../agents/model-catalog-decisions.js";
import { findModelCatalogEntry } from "../../agents/model-catalog-lookup.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { resolveNativeWebSearchRoute } from "../../agents/native-web-search.js";
import { hasAuthProfileForProvider } from "../../agents/tools/model-config.helpers.js";
import { resolveWebSearchToolPolicy } from "../../agents/web-search-tool-policy.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSecretInputRef } from "../../config/types.secrets.js";
import { listSearchProviderOptions } from "../../flows/search-setup.js";
import { resolvePluginCredentialDescriptors } from "../../plugins/credential-descriptors.js";
import { resolveManagedPluginMetadata } from "../../plugins/management-service.js";
import type { PluginWebSearchProviderEntry } from "../../plugins/web-provider-types.js";
import { parseConcreteConfigPathTokens } from "../../shared/dot-path.js";
import {
  isWebSearchProviderConfigured,
  listConfiguredWebSearchProviders,
  resolveWebSearchProviderId,
} from "../../web-search/runtime.js";
import { readPreparedCatalog } from "../server-model-catalog-auth.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import type { GatewayRequestContext } from "./types.js";

type ProviderStatus = WebSearchStatusResult["providers"][number];

function credentialSource(
  provider: PluginWebSearchProviderEntry,
  config: ReturnType<GatewayRequestContext["getRuntimeConfig"]>,
  authStore: AuthProfileStore,
): ProviderStatus["credentialSource"] {
  if (provider.requiresCredential === false) {
    return "none";
  }
  const value = provider.getConfiguredCredentialValue?.(config);
  if (resolveSecretInputRef({ value }).ref) {
    return "secretRef";
  }
  if (typeof value === "string" && value.trim()) {
    return "config";
  }
  if (provider.envVars.some((name) => Boolean(process.env[name]?.trim()))) {
    return "env";
  }
  const fallback = provider.getConfiguredCredentialFallback?.(config)?.value;
  if (resolveSecretInputRef({ value: fallback }).ref) {
    return "secretRef";
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return "config";
  }
  return provider.authProviderId &&
    hasAuthProfileForProvider({ provider: provider.authProviderId, authStore })
    ? "auth-profile"
    : "missing";
}

export async function prepareWebSearchStatus(
  context: GatewayRequestContext,
  request: WebSearchStatusParams,
  requesterProfileId?: string,
) {
  const config = context.getRuntimeConfig();
  const scope = resolveModelAuthAgentScope(config, request.agentId);
  if (!scope.ok) {
    return { error: modelAuthAgentScopeError(scope) };
  }
  // Missing publication is unavailable auth, never permission to reopen storage on a request.
  const authStore = getPreparedRuntimeAuthProfileStoreSnapshot(scope.agentDir) ?? {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  const defaultModel = resolveDefaultModelForAgent({ cfg: config, agentId: scope.agentId });
  const modelRef = {
    provider: request.modelProvider?.trim() || defaultModel.provider,
    model: request.modelId?.trim() || defaultModel.model,
  };
  const metadata = resolveManagedPluginMetadata(config, process.env);
  const sourceConfig = getRuntimeConfigSourceSnapshot() ?? config;
  const available = listConfiguredWebSearchProviders({ config });
  const availableIds = new Set(available.map((entry) => entry.id));
  const entries = new Map(
    [...listSearchProviderOptions(config), ...available].map((entry) => [entry.id, entry]),
  );
  const providers = [...entries.values()]
    .toSorted((a, b) => a.label.localeCompare(b.label))
    .map((entry): ProviderStatus => {
      const manifest = metadata.byPluginId.get(entry.pluginId);
      const credential =
        manifest && entry.credentialPath
          ? resolvePluginCredentialDescriptors(manifest).find(
              (field) =>
                JSON.stringify(field.path) ===
                JSON.stringify(parseConcreteConfigPathTokens(entry.credentialPath)),
            )
          : undefined;
      return {
        id: entry.id,
        pluginId: entry.pluginId,
        label: entry.label,
        hint: entry.hint,
        configured: isWebSearchProviderConfigured({
          provider: entry,
          config,
          agentDir: scope.agentDir,
          authStore,
        }),
        installed: Boolean(manifest),
        available: availableIds.has(entry.id),
        requiresCredential: entry.requiresCredential !== false,
        credentialSource: credentialSource(entry, sourceConfig, authStore),
        configPath:
          entry.configPath === null
            ? []
            : [
                "plugins",
                "entries",
                entry.pluginId,
                "config",
                ...(entry.configPath ?? ["webSearch"]),
              ],
        credentialPath: entry.credentialPath || undefined,
        credential,
        docsUrl: entry.docsUrl || undefined,
        signupUrl: entry.signupUrl || undefined,
      };
    });
  const enabled = config.tools?.web?.search?.enabled !== false;
  const provider = config.tools?.web?.search?.provider?.trim() || null;
  const selectedId = resolveWebSearchProviderId({
    config,
    agentDir: scope.agentDir,
    providers: available,
    authStore,
  });
  const selected = providers.find((entry) => entry.id === selectedId && entry.available);
  const status: WebSearchStatusResult = {
    enabled,
    provider,
    agentId: scope.agentId,
    model: {
      provider: modelRef.provider,
      id: modelRef.model,
      runtime: "unknown",
      runtimeLabel: "Not resolved",
    },
    providers,
    route: { kind: "unavailable", label: "Search unavailable", testable: false },
  };
  const policy = resolveWebSearchToolPolicy({
    config,
    agentId: scope.agentId,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
  });
  if (!enabled || !policy.allowed) {
    status.route = {
      kind: "disabled",
      label: "Search disabled",
      testable: false,
      reason: !enabled
        ? "Web search is disabled in Settings."
        : "The agent's tool policy does not allow web search.",
    };
    return { status, config, agentDir: scope.agentDir };
  }
  // A named provider probe verifies that service, independently of a harness's native tools.
  if (provider && selected) {
    status.testProvider = { id: selected.id, label: selected.label };
  }
  // Use published catalog/auth facts, without starting provider discovery on a Settings read.
  const catalog = await readPreparedCatalog(context, scope.agentId);
  if (catalog) {
    const entry = findModelCatalogEntry(catalog.entries, {
      provider: modelRef.provider,
      modelId: modelRef.model,
    });
    if (entry) {
      const decisions = createModelCatalogDecisions({
        cfg: config,
        agentId: scope.agentId,
        agentDir: scope.agentDir,
        workspaceDir: catalog.workspaceDir,
        snapshot: catalog,
        metadataSnapshot: catalog.metadataSnapshot,
        preparedAuthStore: catalog.authStore,
        preparedRuntimeAuthModes: catalog.authModes,
        preparedRuntimeAuthMaterializations: catalog.authMaterializations,
        requesterProfileId,
        pluginRegistry: catalog.pluginRegistry,
        isCurrent: catalog.isCurrent,
        observationConfig: catalog.observationConfig,
      });
      const variants = catalog.routeVariants.filter(
        (row) => row.provider === entry.provider && row.id === entry.id,
      );
      const host = await decisions.evaluateEntry(entry, variants);
      const evaluation = decisions.evaluateNative(entry, host);
      if (!catalog.isCurrent()) {
        throw new Error("Model catalog changed during search status projection.");
      }
      const runtime = resolveCatalogDecisionRuntime({
        cfg: config,
        agentId: scope.agentId,
        entry,
        evaluation,
        pluginRegistry: catalog.pluginRegistry,
      });
      status.model.runtime = runtime?.id ?? "openclaw";
      status.model.runtimeLabel =
        status.model.runtime === BUILTIN_AGENT_HARNESS_METADATA.id
          ? BUILTIN_AGENT_HARNESS_METADATA.label
          : (catalog.pluginRegistry?.agentHarnesses.find(
              ({ harness }) => harness.id === status.model.runtime,
            )?.harness.label ?? "External agent runtime");
      const native = resolveNativeWebSearchRoute({
        config,
        agentId: scope.agentId,
        agentDir: scope.agentDir,
        modelProvider: modelRef.provider,
        modelId: modelRef.model,
        authStore: catalog.authStore,
        modelApi: evaluation.selectedRoute?.api ?? entry.api,
        modelBaseUrl: evaluation.selectedRoute?.baseUrl ?? entry.baseUrl,
      });
      if (status.model.runtime === "openclaw" && native.kind === "native") {
        status.route = {
          kind: "native",
          provider: native.provider,
          label: "Native web search",
          testable: false,
          reason:
            "Search runs inside the selected model's response. Test it by asking this model to search in a chat.",
        };
        return { status, config, agentDir: scope.agentDir };
      }
      if (status.model.runtime !== "openclaw") {
        status.route = {
          kind: "external",
          provider: status.model.runtime,
          label: `${status.model.runtimeLabel} controls search`,
          testable: false,
          reason:
            "The selected harness determines native search availability when the turn starts. A configured OpenClaw provider does not prove which tool that harness will use. Test search in a chat with this model.",
        };
        return { status, config, agentDir: scope.agentDir };
      }
    }
  }
  if (status.model.runtime === "unknown") {
    status.route = {
      kind: "unavailable",
      label: "Model search route is not ready",
      testable: false,
      reason:
        "The selected model is not in the prepared model catalog. Refresh Models, then try again. An explicitly configured search provider can still be tested separately.",
    };
    return { status, config, agentDir: scope.agentDir };
  }
  status.route = selected
    ? {
        kind: "managed",
        provider: selected.id,
        label: selected.label,
        testable: true,
        ...(selected.configured
          ? {}
          : {
              reason:
                "Provider credentials are missing or unresolved. Configure them before testing.",
            }),
      }
    : {
        kind: "unavailable",
        label: "No search provider available",
        testable: false,
        reason: provider
          ? "The selected search provider is unavailable. Enable or install its plugin and configure its credentials."
          : "Choose a search provider, or select a model with native search.",
      };
  return { status, config, agentDir: scope.agentDir };
}
