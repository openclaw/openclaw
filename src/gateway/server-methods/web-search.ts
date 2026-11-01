import {
  ErrorCodes,
  errorShape,
  type WebSearchStatusParams,
  type WebSearchStatusResult,
  type WebSearchTestResult,
  validateWebSearchStatusParams,
  validateWebSearchTestParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildAuthHealthSummary } from "../../agents/auth-health.js";
import { AUTH_STORE_VERSION } from "../../agents/auth-profiles/constants.js";
import { buildOAuthRefreshFailureLoginCommand } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "../../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { BUILTIN_AGENT_HARNESS_METADATA } from "../../agents/harness/builtin-openclaw-metadata.js";
import {
  prepareModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "../../agents/model-catalog-decisions.js";
import { findModelCatalogEntry } from "../../agents/model-catalog-lookup.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { resolveNativeWebSearchRoute } from "../../agents/native-web-search.js";
import { hasAuthProfileForProvider } from "../../agents/tools/model-config.helpers.js";
import {
  normalizeWebSearchOutput,
  unwrapWebSearchOutputText,
} from "../../agents/tools/web-search-output.js";
import { resolveWebSearchToolPolicy } from "../../agents/web-search-tool-policy.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../../config/io.plugin-metadata.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSecretInputRef } from "../../config/types.secrets.js";
import { listSearchProviderOptions } from "../../flows/search-setup.js";
import { prepareBundledDiscoveryMode } from "../../plugins/bundled-discovery-state.js";
import { resolvePluginCredentialDescriptors } from "../../plugins/credential-descriptors.js";
import type { PluginWebSearchProviderEntry } from "../../plugins/web-provider-types.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { runtimeWebSecretOwnerId } from "../../secrets/runtime-web-secret-owner.js";
import { parseConcreteConfigPathTokens } from "../../shared/dot-path.js";
import {
  isWebSearchProviderConfigured,
  listConfiguredWebSearchProviders,
  resolveWebSearchProviderId,
  runWebSearch,
} from "../../web-search/runtime.js";
import { readPreparedCatalog } from "../server-model-catalog-auth.js";
import { resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { prepareAuthenticatedProfile } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

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

async function prepareWebSearchStatus(
  context: GatewayRequestContext,
  request: WebSearchStatusParams,
  requesterProfileId?: string,
) {
  const config = context.getRuntimeConfig();
  const scope = resolveModelAuthAgentScope(config, request.agentId);
  if (!scope.ok) {
    return { error: scope.error };
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
  const activateDiscovery = await prepareBundledDiscoveryMode();
  const metadata = await resolveConfigWidePluginMetadataSnapshotAsync({ config });
  activateDiscovery();
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
  // Auth-profile search shares model-auth health, so a dead sign-in is reported where search is.
  // Expired OAuth may still refresh on use; only a failed test or search proves it is dead.
  let selectedAuthIssue: string | undefined;
  if (selected?.credentialSource === "auth-profile") {
    const selectedProvider = entries.get(selected.id);
    if (selectedProvider?.authProviderId) {
      const health = buildAuthHealthSummary({
        store: authStore,
        cfg: config,
        providers: [selectedProvider.authProviderId],
      }).providers[0];
      if (health?.status === "expired" || health?.status === "missing") {
        const chatLogin = buildOAuthRefreshFailureLoginCommand(health.provider, {
          surface: "chat",
        });
        selectedAuthIssue = `The ${health.provider} sign-in this provider uses is ${health.status}. If a test search fails, send \`${chatLogin}\` from a private chat or Control UI session, or run \`${buildOAuthRefreshFailureLoginCommand(health.provider)}\`.`;
      }
    }
  }
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
      const decisions = await prepareModelCatalogDecisions({
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
      const host = decisions.evaluateEntry(entry, variants);
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
        modelParams: entry.params,
        pluginMetadataSnapshot: catalog.metadataSnapshot,
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
      reason: [
        "The selected model is not in the prepared model catalog. Refresh Models, then try again. An explicitly configured search provider can still be tested separately.",
        selectedAuthIssue,
      ]
        .filter(Boolean)
        .join(" "),
    };
    return { status, config, agentDir: scope.agentDir };
  }
  status.route = selected
    ? {
        kind: "managed",
        provider: selected.id,
        label: selected.label,
        testable: true,
        ...(!selected.configured
          ? {
              reason:
                "Provider credentials are missing or unresolved. Configure them before testing.",
            }
          : selectedAuthIssue
            ? { reason: selectedAuthIssue }
            : {}),
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

function hasSearchAuthority(
  options: GatewayRequestHandlerOptions,
  required: "read" | "admin",
): boolean {
  const { client, signal, hasCurrentClientAuthority } = options;
  return Boolean(
    client &&
    !client.invalidated &&
    !client.connectionSignal?.aborted &&
    (client.connect.scopes?.includes("operator.admin") ||
      (required === "read" && client.connect.scopes?.includes("operator.read"))) &&
    !signal?.aborted &&
    (!hasCurrentClientAuthority || hasCurrentClientAuthority()),
  );
}

// Provider diagnostics may contain reflected credentials or request headers.
function searchTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|auth|credential|api.?key|secret/i.test(message)) {
    return "The search provider could not authenticate. Check its credentials and account access.";
  }
  if (/429|rate.?limit|quota|billing|credit/i.test(message)) {
    return "The search provider rejected the request because of an account or rate limit. Check its usage and billing.";
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return "The search request was cancelled or timed out. Check connectivity and try again.";
  }
  return "The search provider could not complete the request. Check its endpoint, connectivity, and provider status.";
}

function respondSearchError(
  respond: RespondFn,
  code: Parameters<typeof errorShape>[0],
  message: string,
) {
  respond(false, undefined, errorShape(code, message));
}

export const webSearchHandlers: GatewayRequestHandlers = {
  "webSearch.status": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateWebSearchStatusParams, "webSearch.status", respond)) {
      return;
    }
    if (Boolean(params.modelProvider) !== Boolean(params.modelId)) {
      respondSearchError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "modelProvider and modelId must be supplied together.",
      );
      return;
    }
    if (!hasSearchAuthority(options, "read")) {
      respondSearchError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "Current read access is required to inspect search settings.",
      );
      return;
    }
    try {
      const requester = await prepareAuthenticatedProfile(options);
      requester.assertCurrent();
      const prepared = await prepareWebSearchStatus(context, params, requester.profileId);
      requester.assertCurrent();
      if (prepared.error) {
        respond(false, undefined, prepared.error);
      } else if (
        !hasSearchAuthority(options, "read") ||
        context.getRuntimeConfig() !== prepared.config
      ) {
        respondSearchError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "Search settings changed. Refresh and try again.",
        );
      } else {
        respond(true, prepared.status, undefined);
      }
    } catch {
      respondSearchError(
        respond,
        ErrorCodes.UNAVAILABLE,
        "Search settings are not ready. Refresh and try again.",
      );
    }
  },
  "webSearch.test": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateWebSearchTestParams, "webSearch.test", respond)) {
      return;
    }
    const query = params.query.trim();
    if (!query || Boolean(params.modelProvider) !== Boolean(params.modelId)) {
      respondSearchError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "Provide a search query and both model selection fields, or neither.",
      );
      return;
    }
    if (!hasSearchAuthority(options, "admin")) {
      respondSearchError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "Current administrator access is required to test search.",
      );
      return;
    }
    try {
      const requester = await prepareAuthenticatedProfile(options);
      requester.assertCurrent();
      const prepared = await prepareWebSearchStatus(context, params, requester.profileId);
      requester.assertCurrent();
      if (prepared.error) {
        respond(false, undefined, prepared.error);
        return;
      }
      const { status, config, agentDir } = prepared;
      const hasCurrentAuthority = () => {
        requester.assertCurrent();
        return hasSearchAuthority(options, "admin") && context.getRuntimeConfig() === config;
      };
      if (!hasCurrentAuthority()) {
        respondSearchError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "Search settings or access changed. Refresh and try again.",
        );
        return;
      }
      const explicitProvider = params.providerId?.trim();
      const provider = explicitProvider ?? status.route.provider;
      const canTest = explicitProvider
        ? explicitProvider === status.testProvider?.id
        : status.route.kind === "managed" && status.route.testable;
      if (!canTest || !provider) {
        respondSearchError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          status.route.reason ?? "Choose an available search provider before testing.",
        );
        return;
      }
      const startedAt = Date.now();
      let result: WebSearchTestResult;
      try {
        assertSecretOwnerAvailable("capability", runtimeWebSecretOwnerId("search", provider));
        const signal = AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          ...(options.client?.connectionSignal ? [options.client.connectionSignal] : []),
          AbortSignal.timeout((config.tools?.web?.search?.timeoutSeconds ?? 30) * 1_000),
        ]);
        const executed = await runWebSearch({
          config: {
            ...config,
            tools: {
              ...config.tools,
              web: {
                ...config.tools?.web,
                search: { ...config.tools?.web?.search, cacheTtlMinutes: 0 },
              },
            },
          },
          preferInputConfig: true,
          agentDir,
          providerId: provider,
          args: { query, count: 5 },
          signal,
          assertCurrent: () => {
            if (!hasCurrentAuthority()) {
              throw new Error("Search settings or access changed during the test.");
            }
            assertSecretOwnerAvailable("capability", runtimeWebSecretOwnerId("search", provider));
          },
        });
        const normalized = normalizeWebSearchOutput({ ...executed, query });
        const latencyMs = Date.now() - startedAt;
        if (normalized.kind === "results" || normalized.kind === "answer") {
          result = {
            provider: executed.provider,
            latencyMs,
            status: "ok",
            ...(normalized.kind === "results"
              ? {
                  results: normalized.results.map((row) => ({
                    title: unwrapWebSearchOutputText(row.title),
                    url: row.url,
                    ...(row.snippet ? { snippet: unwrapWebSearchOutputText(row.snippet) } : {}),
                  })),
                }
              : {
                  content: unwrapWebSearchOutputText(normalized.content),
                  citations: normalized.citations?.map((row) => ({
                    url: row.url,
                    ...(row.title ? { title: unwrapWebSearchOutputText(row.title) } : {}),
                  })),
                }),
            cached: normalized.cached === true,
          };
        } else {
          result = {
            provider,
            latencyMs,
            status: "error",
            error:
              normalized.kind === "error"
                ? searchTestError(normalized.message)
                : "The provider returned a response without supported search results or an answer.",
          };
        }
      } catch (error) {
        result = {
          provider,
          latencyMs: Date.now() - startedAt,
          status: "error",
          error: searchTestError(error),
        };
      }
      if (!hasCurrentAuthority()) {
        respondSearchError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "Search settings or access changed during the test. Refresh and try again.",
        );
        return;
      }
      respond(true, result, undefined);
    } catch {
      respondSearchError(
        respond,
        ErrorCodes.UNAVAILABLE,
        "Search settings are not ready. Refresh and try again.",
      );
    }
  },
};
