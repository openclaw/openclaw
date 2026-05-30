import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveUsableCustomProviderApiKey } from "../../agents/model-auth.js";
import {
  loadModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import { resolveVisibleModelCatalog } from "../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import {
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../../agents/provider-request-config.js";
import { buildGuardedModelFetch } from "../../agents/provider-transport-fetch.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { Model } from "../../llm/types.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

type ModelsListView = ModelCatalogBrowseView;
type ProbeApi = "openai-completions" | "openai-responses";

export type ModelsProbeResult = {
  provider: string;
  model: string;
  api?: string;
  ok: boolean;
  status?: number;
  elapsedMs: number;
  message: string;
};

let loggedSlowModelsListCatalog = false;

function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  return typeof params.view === "string" ? (params.view as ModelsListView) : "default";
}

function omitRuntimeModelParams(entry: ModelCatalogEntry): ModelCatalogEntry {
  const { params: _params, ...rest } = entry as ModelCatalogEntry & {
    params?: Record<string, unknown>;
  };
  return rest;
}

function omitRuntimeModelParamsFromCatalog(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.map(omitRuntimeModelParams);
}

function readStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function readTimeoutMs(params: Record<string, unknown>): number {
  const raw = params.timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 20_000;
  }
  return Math.min(60_000, Math.max(1_000, Math.floor(raw)));
}

function resolveProviderConfig(
  providers: Record<string, ModelProviderConfig> | undefined,
  providerId: string,
): ModelProviderConfig | undefined {
  if (!providers) {
    return undefined;
  }
  const direct = providers[providerId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(providerId);
  return Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
}

function resolveModelConfig(
  providerConfig: ModelProviderConfig,
  modelId: string,
): ModelDefinitionConfig | undefined {
  return providerConfig.models?.find((entry) => entry?.id === modelId);
}

function readProviderConfigParam(params: Record<string, unknown>): ModelProviderConfig | undefined {
  const value = params.providerConfig;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as ModelProviderConfig;
}

function readStringHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) {
      next[key] = value.trim();
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function readDraftApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed !== REDACTED_SENTINEL ? trimmed : undefined;
}

function stableJsonValue(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    next[key] = stableJsonValue((value as Record<string, unknown>)[key]);
  }
  return next;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function providerCredentialTargetFingerprint(
  providerConfig: ModelProviderConfig,
  modelId: string,
): string {
  const modelConfig = resolveModelConfig(providerConfig, modelId);
  return stableJson({
    api: modelConfig?.api ?? providerConfig.api,
    authHeader: providerConfig.authHeader,
    baseUrl: (modelConfig?.baseUrl ?? providerConfig.baseUrl)?.trim(),
    modelHeaders: readStringHeaders(modelConfig?.headers),
    providerHeaders: readStringHeaders(providerConfig.headers),
    providerRequest: sanitizeConfiguredModelProviderRequest(providerConfig.request),
  });
}

function canUseSavedProviderApiKeyForDraft(params: {
  draftProviderConfig: ModelProviderConfig | undefined;
  model: string;
  savedProviderConfig: ModelProviderConfig | undefined;
}): boolean {
  if (!params.draftProviderConfig) {
    return true;
  }
  if (!params.savedProviderConfig) {
    return false;
  }
  return (
    providerCredentialTargetFingerprint(params.draftProviderConfig, params.model) ===
    providerCredentialTargetFingerprint(params.savedProviderConfig, params.model)
  );
}

function resolveProbeUrl(baseUrl: string, api: ProbeApi): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  const suffix = api === "openai-responses" ? "/responses" : "/chat/completions";
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

function buildProbePayload(api: ProbeApi, model: string): Record<string, unknown> {
  if (api === "openai-responses") {
    return {
      model,
      input: "Reply with OK.",
      max_output_tokens: 8,
      store: false,
    };
  }
  return {
    model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
    stream: false,
  };
}

function sanitizeProbeMessage(value: unknown): string {
  if (value instanceof Error && value.name === "AbortError") {
    return "request timed out";
  }
  if (typeof value === "string") {
    return value.slice(0, 500);
  }
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") {
      return message.slice(0, 500);
    }
  }
  return formatForLog(value).slice(0, 500);
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const workspaceDir =
        resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ??
        resolveDefaultAgentWorkspaceDir();
      const view = resolveModelsListView(params);
      const catalog = await loadModelCatalogForBrowse({
        cfg,
        view,
        loadCatalog: context.loadGatewayModelCatalog,
        onTimeout: (timeoutMs) => {
          if (loggedSlowModelsListCatalog) {
            return;
          }
          loggedSlowModelsListCatalog = true;
          context.logGateway.debug(
            `models.list continuing without model catalog after ${timeoutMs}ms`,
          );
        },
      });
      if (view === "all") {
        respond(true, { models: omitRuntimeModelParamsFromCatalog(catalog) }, undefined);
        return;
      }
      const models = await resolveVisibleModelCatalog({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        workspaceDir,
        view,
        runtimeAuthDiscovery: false,
      });
      respond(true, { models: omitRuntimeModelParamsFromCatalog(models) }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.probe": async ({ params, respond, context }) => {
    const p = params as Record<string, unknown>;
    const provider = readStringParam(p, "provider");
    const model = readStringParam(p, "model");
    if (!provider || !model) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "provider and model are required"),
      );
      return;
    }
    const startedAt = Date.now();
    try {
      const cfg = context.getRuntimeConfig();
      const draftProviderConfig = readProviderConfigParam(p);
      const savedProviderConfig = resolveProviderConfig(cfg.models?.providers, provider);
      const providerConfig = draftProviderConfig ?? savedProviderConfig;
      if (!providerConfig) {
        respond(
          true,
          {
            provider,
            model,
            ok: false,
            elapsedMs: Date.now() - startedAt,
            message: `provider "${provider}" is not configured`,
          } satisfies ModelsProbeResult,
          undefined,
        );
        return;
      }
      const modelConfig = resolveModelConfig(providerConfig, model);
      const api = modelConfig?.api ?? providerConfig.api;
      const baseUrl = modelConfig?.baseUrl ?? providerConfig.baseUrl;
      if (api !== "openai-completions" && api !== "openai-responses") {
        respond(
          true,
          {
            provider,
            model,
            api,
            ok: false,
            elapsedMs: Date.now() - startedAt,
            message: `live probe is not supported for api "${api ?? "unknown"}"`,
          } satisfies ModelsProbeResult,
          undefined,
        );
        return;
      }
      if (!baseUrl?.trim()) {
        respond(
          true,
          {
            provider,
            model,
            api,
            ok: false,
            elapsedMs: Date.now() - startedAt,
            message: "provider baseUrl is not configured",
          } satisfies ModelsProbeResult,
          undefined,
        );
        return;
      }
      const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig.request);
      const requestConfig = resolveProviderRequestConfig({
        provider,
        api,
        baseUrl,
        providerHeaders: readStringHeaders(providerConfig.headers),
        modelHeaders: readStringHeaders(modelConfig?.headers),
        authHeader: providerConfig.authHeader,
        request: providerRequest,
        capability: "llm",
        transport: "stream",
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...requestConfig.headers,
      };
      const draftApiKey = readDraftApiKey(providerConfig.apiKey);
      const savedApiKeyAllowed = canUseSavedProviderApiKeyForDraft({
        draftProviderConfig,
        model,
        savedProviderConfig,
      });
      const auth = draftApiKey
        ? { apiKey: draftApiKey }
        : savedApiKeyAllowed
          ? resolveUsableCustomProviderApiKey({ cfg, provider })
          : undefined;
      const hasAuthorizationHeader = Object.keys(headers).some(
        (key) => key.toLowerCase() === "authorization",
      );
      const shouldInjectDefaultBearer =
        auth?.apiKey &&
        !requestConfig.auth.configured &&
        providerConfig.authHeader !== false &&
        !hasAuthorizationHeader;
      if (shouldInjectDefaultBearer) {
        headers.authorization = `Bearer ${auth.apiKey}`;
      }
      const probeModel = attachModelProviderRequestTransport(
        {
          id: model,
          name: modelConfig?.name ?? model,
          api,
          provider: provider as Model["provider"],
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: modelConfig?.contextWindow ?? providerConfig.contextWindow ?? 8_192,
          maxTokens: modelConfig?.maxTokens ?? providerConfig.maxTokens ?? 8,
          headers,
        } satisfies Model,
        providerRequest,
      );
      const probeFetch = buildGuardedModelFetch(probeModel, readTimeoutMs(p), {
        sanitizeSse: false,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), readTimeoutMs(p));
      let response: Response;
      try {
        response = await probeFetch(resolveProbeUrl(baseUrl, api), {
          method: "POST",
          headers,
          body: JSON.stringify(buildProbePayload(api, model)),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const elapsedMs = Date.now() - startedAt;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        respond(
          true,
          {
            provider,
            model,
            api,
            ok: false,
            status: response.status,
            elapsedMs,
            message: body.slice(0, 500) || response.statusText || `HTTP ${response.status}`,
          } satisfies ModelsProbeResult,
          undefined,
        );
        return;
      }
      await response.arrayBuffer().catch(() => undefined);
      respond(
        true,
        {
          provider,
          model,
          api,
          ok: true,
          status: response.status,
          elapsedMs,
          message: "model call succeeded",
        } satisfies ModelsProbeResult,
        undefined,
      );
    } catch (err) {
      respond(
        true,
        {
          provider,
          model,
          ok: false,
          elapsedMs: Date.now() - startedAt,
          message: sanitizeProbeMessage(err),
        } satisfies ModelsProbeResult,
        undefined,
      );
    }
  },
};
