import { randomUUID } from "node:crypto";
import { normalizeModelRef, parseModelRef } from "../agents/model-selection.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginIds } from "../plugins/channel-plugin-ids.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntimeLoaderLogger } from "../plugins/runtime/load-context.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginLogger } from "../plugins/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import type { ErrorShape } from "./protocol/index.js";
import { ErrorCodes, PROTOCOL_VERSION } from "./protocol/index.js";
import { handleGatewayRequest } from "./server-methods.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import {
  OPENCLAW_INTERSESSION_SEND_DENIED,
  OPENCLAW_INTERSESSION_SEND_FAILED,
  OPENCLAW_INTERSESSION_SESSION_NOT_FOUND,
  OPENCLAW_INTERSESSION_UNAVAILABLE,
} from "../plugin-sdk/error-runtime.js";

// ── Fallback gateway context for non-WS paths (Telegram, WhatsApp, etc.) ──
// The WS path sets a per-request scope via AsyncLocalStorage, but channel
// adapters (Telegram polling, etc.) invoke the agent directly without going
// through handleGatewayRequest. We store the gateway context at startup so
// dispatchGatewayMethod can use it as a fallback.

const FALLBACK_GATEWAY_CONTEXT_STATE_KEY: unique symbol = Symbol.for(
  "openclaw.fallbackGatewayContextState",
);

type FallbackGatewayContextState = {
  context: GatewayRequestContext | undefined;
  resolveContext: (() => GatewayRequestContext | undefined) | undefined;
};

const getFallbackGatewayContextState = () =>
  resolveGlobalSingleton<FallbackGatewayContextState>(FALLBACK_GATEWAY_CONTEXT_STATE_KEY, () => ({
    context: undefined,
    resolveContext: undefined,
  }));

export function setFallbackGatewayContext(ctx: GatewayRequestContext): void {
  const fallbackGatewayContextState = getFallbackGatewayContextState();
  fallbackGatewayContextState.context = ctx;
  fallbackGatewayContextState.resolveContext = undefined;
}

export function setFallbackGatewayContextResolver(
  resolveContext: () => GatewayRequestContext | undefined,
): void {
  const fallbackGatewayContextState = getFallbackGatewayContextState();
  fallbackGatewayContextState.resolveContext = resolveContext;
}

function getFallbackGatewayContext(): GatewayRequestContext | undefined {
  const fallbackGatewayContextState = getFallbackGatewayContextState();
  const resolved = fallbackGatewayContextState.resolveContext?.();
  return resolved ?? fallbackGatewayContextState.context;
}

type PluginSubagentOverridePolicy = {
  allowModelOverride: boolean;
  allowAnyModel: boolean;
  hasConfiguredAllowlist: boolean;
  allowedModels: Set<string>;
};

type PluginSubagentPolicyState = {
  policies: Record<string, PluginSubagentOverridePolicy>;
};

const PLUGIN_SUBAGENT_POLICY_STATE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginSubagentOverridePolicyState",
);

const getPluginSubagentPolicyState = () =>
  resolveGlobalSingleton<PluginSubagentPolicyState>(PLUGIN_SUBAGENT_POLICY_STATE_KEY, () => ({
    policies: {},
  }));

function normalizeAllowedModelRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  const providerRaw = trimmed.slice(0, slash).trim();
  const modelRaw = trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const normalized = normalizeModelRef(providerRaw, modelRaw);
  return `${normalized.provider}/${normalized.model}`;
}

export function setPluginSubagentOverridePolicies(cfg: OpenClawConfig): void {
  const pluginSubagentPolicyState = getPluginSubagentPolicyState();
  const normalized = normalizePluginsConfig(cfg.plugins);
  const policies: PluginSubagentPolicyState["policies"] = {};
  for (const [pluginId, entry] of Object.entries(normalized.entries)) {
    const allowModelOverride = entry.subagent?.allowModelOverride === true;
    const hasConfiguredAllowlist = entry.subagent?.hasAllowedModelsConfig === true;
    const configuredAllowedModels = entry.subagent?.allowedModels ?? [];
    const allowedModels = new Set<string>();
    let allowAnyModel = false;
    for (const modelRef of configuredAllowedModels) {
      const normalizedModelRef = normalizeAllowedModelRef(modelRef);
      if (!normalizedModelRef) {
        continue;
      }
      if (normalizedModelRef === "*") {
        allowAnyModel = true;
        continue;
      }
      allowedModels.add(normalizedModelRef);
    }
    if (
      !allowModelOverride &&
      !hasConfiguredAllowlist &&
      allowedModels.size === 0 &&
      !allowAnyModel
    ) {
      continue;
    }
    policies[pluginId] = {
      allowModelOverride,
      allowAnyModel,
      hasConfiguredAllowlist,
      allowedModels,
    };
  }
  pluginSubagentPolicyState.policies = policies;
}

function authorizeFallbackModelOverride(params: {
  pluginId?: string;
  provider?: string;
  model?: string;
}): { allowed: true } | { allowed: false; reason: string } {
  const pluginSubagentPolicyState = getPluginSubagentPolicyState();
  const pluginId = params.pluginId?.trim();
  if (!pluginId) {
    return {
      allowed: false,
      reason: "provider/model override requires plugin identity in fallback subagent runs.",
    };
  }
  const policy = pluginSubagentPolicyState.policies[pluginId];
  if (!policy?.allowModelOverride) {
    return {
      allowed: false,
      reason:
        `plugin "${pluginId}" is not trusted for fallback provider/model override requests. ` +
        "See https://docs.openclaw.ai/tools/plugin#runtime-helpers and search for: " +
        "plugins.entries.<id>.subagent.allowModelOverride",
    };
  }
  if (policy.allowAnyModel) {
    return { allowed: true };
  }
  if (policy.hasConfiguredAllowlist && policy.allowedModels.size === 0) {
    return {
      allowed: false,
      reason: `plugin "${pluginId}" configured subagent.allowedModels, but none of the entries normalized to a valid provider/model target.`,
    };
  }
  if (policy.allowedModels.size === 0) {
    return { allowed: true };
  }
  const requestedModelRef = resolveRequestedFallbackModelRef(params);
  if (!requestedModelRef) {
    return {
      allowed: false,
      reason:
        "fallback provider/model overrides that use an allowlist must resolve to a canonical provider/model target.",
    };
  }
  if (policy.allowedModels.has(requestedModelRef)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `model override "${requestedModelRef}" is not allowlisted for plugin "${pluginId}".`,
  };
}

function resolveRequestedFallbackModelRef(params: {
  provider?: string;
  model?: string;
}): string | null {
  if (params.provider && params.model) {
    const normalizedRequest = normalizeModelRef(params.provider, params.model);
    return `${normalizedRequest.provider}/${normalizedRequest.model}`;
  }
  const rawModel = params.model?.trim();
  if (!rawModel || !rawModel.includes("/")) {
    return null;
  }
  const parsed = parseModelRef(rawModel, "");
  if (!parsed?.provider || !parsed.model) {
    return null;
  }
  return `${parsed.provider}/${parsed.model}`;
}

// ── Internal gateway dispatch for plugin runtime ────────────────────

function createSyntheticOperatorClient(params?: {
  allowModelOverride?: boolean;
  scopes?: string[];
}): GatewayRequestOptions["client"] {
  return {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: "internal",
        platform: "node",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes: params?.scopes ?? [WRITE_SCOPE],
    },
    internal: {
      allowModelOverride: params?.allowModelOverride === true,
    },
  };
}

function hasAdminScope(client: GatewayRequestOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

function canClientUseModelOverride(client: GatewayRequestOptions["client"]): boolean {
  return hasAdminScope(client) || client?.internal?.allowModelOverride === true;
}

type GatewayDispatchError = Error & {
  gatewayCode?: ErrorShape["code"];
  gatewayDetails?: ErrorShape["details"];
  gatewayRetryable?: boolean;
  gatewayRetryAfterMs?: number;
};

function createGatewayDispatchError(method: string, error?: ErrorShape): GatewayDispatchError {
  return Object.assign(new Error(error?.message ?? `Gateway method "${method}" failed.`), {
    gatewayCode: error?.code,
    gatewayDetails: error?.details,
    gatewayRetryable: error?.retryable,
    gatewayRetryAfterMs: error?.retryAfterMs,
  });
}

async function dispatchGatewayMethod<T>(
  method: string,
  params: Record<string, unknown>,
  options?: {
    allowSyntheticModelOverride?: boolean;
    syntheticScopes?: string[];
  },
): Promise<T> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.context ?? getFallbackGatewayContext();
  const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
  if (!context) {
    throw new Error(
      `Plugin runtime gateway dispatch requires a gateway request scope (method: ${method}). No scope set and no fallback context available.`,
    );
  }

  let result: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `plugin-runtime-${randomUUID()}`,
      method,
      params,
    },
    client:
      scope?.client ??
      createSyntheticOperatorClient({
        allowModelOverride: options?.allowSyntheticModelOverride === true,
        scopes: options?.syntheticScopes,
      }),
    isWebchatConnect,
    respond: (ok, payload, error) => {
      if (!result) {
        result = { ok, payload, error };
      }
    },
    context,
  });

  if (!result) {
    throw new Error(`Gateway method "${method}" completed without a response.`);
  }
  if (!result.ok) {
    throw createGatewayDispatchError(method, result.error);
  }
  return result.payload as T;
}

function collectStructuredTextCandidates(
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): string[] {
  if (depth > 3 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStructuredTextCandidates(entry, seen, depth + 1));
  }
  if (typeof value !== "object" || seen.has(value)) {
    return [];
  }
  seen.add(value);
  return Object.values(value).flatMap((entry) =>
    collectStructuredTextCandidates(entry, seen, depth + 1),
  );
}

function isInterSessionMessageRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInterSessionRuntimeCode(value: unknown): value is string {
  return (
    value === OPENCLAW_INTERSESSION_SESSION_NOT_FOUND ||
    value === OPENCLAW_INTERSESSION_SEND_DENIED ||
    value === OPENCLAW_INTERSESSION_UNAVAILABLE ||
    value === OPENCLAW_INTERSESSION_SEND_FAILED
  );
}

function createInterSessionSendError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function includesSessionNotFoundText(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("session not found") ||
    normalized.includes("no session found") ||
    normalized.includes("no longer exists in configuration")
  );
}

function includesSendDeniedText(value: string): boolean {
  return value.toLowerCase().includes("send blocked by session policy");
}

function mapInterSessionSendError(error: unknown): Error & { code: string } {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    isInterSessionRuntimeCode((error as { code?: unknown }).code)
  ) {
    return error as Error & { code: string };
  }

  const message = error instanceof Error ? error.message : "Gateway sessions.send failed.";
  const dispatchError = error instanceof Error ? (error as GatewayDispatchError) : undefined;
  const gatewayCode = dispatchError?.gatewayCode;
  const detailTexts = collectStructuredTextCandidates(dispatchError?.gatewayDetails);

  if (gatewayCode === ErrorCodes.UNAVAILABLE) {
    return createInterSessionSendError(OPENCLAW_INTERSESSION_UNAVAILABLE, message);
  }
  if (gatewayCode === ErrorCodes.INVALID_REQUEST) {
    if (detailTexts.some(includesSessionNotFoundText)) {
      return createInterSessionSendError(OPENCLAW_INTERSESSION_SESSION_NOT_FOUND, message);
    }
    if (detailTexts.some(includesSendDeniedText)) {
      return createInterSessionSendError(OPENCLAW_INTERSESSION_SEND_DENIED, message);
    }
    if (includesSessionNotFoundText(message)) {
      return createInterSessionSendError(OPENCLAW_INTERSESSION_SESSION_NOT_FOUND, message);
    }
    if (includesSendDeniedText(message)) {
      return createInterSessionSendError(OPENCLAW_INTERSESSION_SEND_DENIED, message);
    }
  }

  return createInterSessionSendError(OPENCLAW_INTERSESSION_SEND_FAILED, message);
}

export function createGatewaySubagentRuntime(): PluginRuntime["subagent"] {
  const getSessionMessages: PluginRuntime["subagent"]["getSessionMessages"] = async (params) => {
    const payload = await dispatchGatewayMethod<{ messages?: unknown[] }>("sessions.get", {
      key: params.sessionKey,
      ...(params.limit != null && { limit: params.limit }),
    });
    return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
  };

  return {
    async run(params) {
      const scope = getPluginRuntimeGatewayRequestScope();
      const overrideRequested = Boolean(params.provider || params.model);
      const hasRequestScopeClient = Boolean(scope?.client);
      let allowOverride = hasRequestScopeClient && canClientUseModelOverride(scope?.client ?? null);
      let allowSyntheticModelOverride = false;
      if (overrideRequested && !allowOverride && !hasRequestScopeClient) {
        const fallbackAuth = authorizeFallbackModelOverride({
          pluginId: scope?.pluginId,
          provider: params.provider,
          model: params.model,
        });
        if (!fallbackAuth.allowed) {
          throw new Error(fallbackAuth.reason);
        }
        allowOverride = true;
        allowSyntheticModelOverride = true;
      }
      if (overrideRequested && !allowOverride) {
        throw new Error("provider/model override is not authorized for this plugin subagent run.");
      }
      const payload = await dispatchGatewayMethod<{ runId?: string }>(
        "agent",
        {
          sessionKey: params.sessionKey,
          message: params.message,
          deliver: params.deliver ?? false,
          ...(allowOverride && params.provider && { provider: params.provider }),
          ...(allowOverride && params.model && { model: params.model }),
          ...(params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt }),
          ...(params.lane && { lane: params.lane }),
          // The gateway `agent` schema requires `idempotencyKey: NonEmptyString`,
          // so fall back to a generated UUID when the caller omits it. Without
          // this, plugin subagent runs (for example memory-core dreaming
          // narrative) silently fail schema validation at the gateway.
          idempotencyKey: params.idempotencyKey || randomUUID(),
        },
        {
          allowSyntheticModelOverride,
        },
      );
      const runId = payload?.runId;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Gateway agent method returned an invalid runId.");
      }
      return { runId };
    },
    async waitForRun(params) {
      const payload = await dispatchGatewayMethod<{ status?: string; error?: string }>(
        "agent.wait",
        {
          runId: params.runId,
          ...(params.timeoutMs != null && { timeoutMs: params.timeoutMs }),
        },
      );
      const status = payload?.status;
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new Error(`Gateway agent.wait returned unexpected status: ${status}`);
      }
      return {
        status,
        ...(typeof payload?.error === "string" && payload.error && { error: payload.error }),
      };
    },
    getSessionMessages,
    async getSession(params) {
      return getSessionMessages(params);
    },
    async deleteSession(params) {
      await dispatchGatewayMethod("sessions.delete", {
        key: params.sessionKey,
        deleteTranscript: params.deleteTranscript ?? true,
      });
    },
  };
}

export function createGatewayInterSessionRuntime(): PluginRuntime["interSession"] {
  return {
    async send(params) {
      try {
        const payload = await dispatchGatewayMethod<{ runId?: string }>("sessions.send", {
          key: params.sessionKey,
          message: params.message,
          idempotencyKey: params.idempotencyKey ?? randomUUID(),
        });
        const runId = payload?.runId;
        if (!isInterSessionMessageRef(runId)) {
          throw createInterSessionSendError(
            OPENCLAW_INTERSESSION_SEND_FAILED,
            "Gateway sessions.send returned an invalid runId.",
          );
        }
        return { messageRef: runId };
      } catch (error) {
        throw mapInterSessionSendError(error);
      }
    },
  };
}

// ── Plugin loading ──────────────────────────────────────────────────

function createGatewayPluginRegistrationLogger(params?: {
  suppressInfoLogs?: boolean;
}): PluginLogger {
  const logger = createPluginRuntimeLoaderLogger();
  if (params?.suppressInfoLogs !== true) {
    return logger;
  }
  return {
    ...logger,
    info: (_message: string) => undefined,
  };
}

export function loadGatewayPlugins(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir: string;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  coreGatewayHandlers: Record<string, GatewayRequestHandler>;
  baseMethods: string[];
  pluginIds?: string[];
  preferSetupRuntimeForChannelPlugins?: boolean;
  suppressPluginInfoLogs?: boolean;
}) {
  const activationAutoEnabled =
    params.activationSourceConfig !== undefined
      ? applyPluginAutoEnable({
          config: params.activationSourceConfig,
          env: process.env,
        })
      : undefined;
  const autoEnabled =
    params.activationSourceConfig !== undefined
      ? {
          config: params.cfg,
          changes: activationAutoEnabled?.changes ?? [],
          autoEnabledReasons:
            params.autoEnabledReasons ?? activationAutoEnabled?.autoEnabledReasons ?? {},
        }
      : params.autoEnabledReasons !== undefined
        ? {
            config: params.cfg,
            changes: [],
            autoEnabledReasons: params.autoEnabledReasons,
          }
        : applyPluginAutoEnable({
            config: params.cfg,
            env: process.env,
          });
  const resolvedConfig = autoEnabled.config;
  const pluginIds =
    params.pluginIds ??
    resolveGatewayStartupPluginIds({
      config: resolvedConfig,
      activationSourceConfig: params.activationSourceConfig,
      workspaceDir: params.workspaceDir,
      env: process.env,
    });
  if (pluginIds.length === 0) {
    const pluginRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(pluginRegistry, undefined, "gateway-bindable", params.workspaceDir);
    return {
      pluginRegistry,
      gatewayMethods: [...params.baseMethods],
    };
  }
  const pluginRegistry = loadOpenClawPlugins({
    config: resolvedConfig,
    activationSourceConfig: params.activationSourceConfig ?? params.cfg,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: pluginIds,
    logger: createGatewayPluginRegistrationLogger({
      suppressInfoLogs: params.suppressPluginInfoLogs,
    }),
    coreGatewayHandlers: params.coreGatewayHandlers,
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
    },
    preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
  });
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = Array.from(new Set([...params.baseMethods, ...pluginMethods]));
  return { pluginRegistry, gatewayMethods };
}
