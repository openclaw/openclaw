import type { Api, Message } from "@mariozechner/pi-ai";
import { normalizeModelRef } from "../../agents/model-selection.js";
import type { NormalizedUsage, UsageLike } from "../../agents/usage.js";
import { normalizeUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getChildLogger } from "../../logging.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { normalizePluginsConfig } from "../config-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type {
  PluginLlmCompleteCaller,
  PluginLlmCompleteParams,
  PluginLlmCompleteResult,
  PluginLlmCompleteUsage,
  PluginRuntimeCore,
  RuntimeLogger,
} from "./types-core.js";

export type RuntimeLlmAuthority = {
  caller?: PluginLlmCompleteCaller;
  sessionKey?: string;
  agentId?: string;
  requiresBoundAgent?: boolean;
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  allowedModels?: readonly string[];
  allowComplete?: boolean;
  denyReason?: string;
};

export type CreateRuntimeLlmOptions = {
  getConfig?: () => OpenClawConfig | undefined;
  authority?: RuntimeLlmAuthority;
  logger?: RuntimeLogger;
};

type RuntimeLlmOverridePolicy = {
  allowAgentIdOverride: boolean;
  allowModelOverride: boolean;
  hasConfiguredAllowedModels: boolean;
  allowAnyModel: boolean;
  allowedModels: Set<string>;
};

const defaultLogger = getChildLogger({ capability: "runtime.llm" });

function toRuntimeLogger(logger: typeof defaultLogger): RuntimeLogger {
  return {
    debug: (message, meta) => logger.debug?.(meta, message),
    info: (message, meta) => logger.info(meta, message),
    warn: (message, meta) => logger.warn(meta, message),
    error: (message, meta) => logger.error(meta, message),
  };
}

function normalizeCaller(
  caller?: PluginLlmCompleteCaller,
  fallback?: PluginLlmCompleteCaller,
): PluginLlmCompleteCaller {
  const source = caller ?? fallback;
  if (!source) {
    return { kind: "unknown" };
  }
  return {
    kind: source.kind,
    ...(normalizeOptionalString(source.id) ? { id: source.id!.trim() } : {}),
    ...(normalizeOptionalString(source.name) ? { name: source.name!.trim() } : {}),
  };
}

function resolveTrustedCaller(authority?: RuntimeLlmAuthority): PluginLlmCompleteCaller {
  if (authority?.caller?.kind === "context-engine") {
    return normalizeCaller(authority.caller);
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const scopedPluginId = normalizeOptionalString(scope?.pluginId);
  if (scopedPluginId) {
    return { kind: "plugin", id: scopedPluginId };
  }
  return normalizeCaller(authority?.caller);
}

function resolveRuntimeConfig(options: CreateRuntimeLlmOptions): OpenClawConfig {
  const cfg = options.getConfig?.();
  if (!cfg) {
    throw new Error("Plugin LLM completion requires an injected runtime config scope.");
  }
  return cfg;
}

async function resolveAgentId(params: {
  request: PluginLlmCompleteParams;
  cfg: OpenClawConfig;
  authority?: RuntimeLlmAuthority;
  allowAgentIdOverride: boolean;
}): Promise<string> {
  const authorityAgentId = normalizeOptionalString(params.authority?.agentId);
  const requestedAgentId = normalizeOptionalString(params.request.agentId);
  if (params.authority?.requiresBoundAgent && !authorityAgentId) {
    throw new Error("Plugin LLM completion is not bound to an active session agent.");
  }
  if (authorityAgentId) {
    if (requestedAgentId && requestedAgentId !== authorityAgentId && !params.allowAgentIdOverride) {
      throw new Error("Plugin LLM completion cannot override the active session agent.");
    }
    return authorityAgentId;
  }
  if (requestedAgentId) {
    if (!params.allowAgentIdOverride) {
      throw new Error("Plugin LLM completion cannot override the target agent.");
    }
    return requestedAgentId;
  }
  const { resolveDefaultAgentId } = await import("../../agents/agent-scope.js");
  return resolveDefaultAgentId(params.cfg);
}

function buildSystemPrompt(params: PluginLlmCompleteParams): string | undefined {
  const segments = [
    normalizeOptionalString(params.systemPrompt),
    ...params.messages
      .filter((message) => message.role === "system")
      .map((message) => normalizeOptionalString(message.content)),
  ].filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

function buildMessages(params: {
  request: PluginLlmCompleteParams;
  provider: string;
  model: string;
  api: Api;
}): Message[] {
  const now = Date.now();
  return params.request.messages
    .filter((message) => message.role !== "system")
    .map((message) =>
      message.role === "user"
        ? { role: "user" as const, content: message.content, timestamp: now }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.content }],
            api: params.api,
            provider: params.provider,
            model: params.model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: now,
          },
    );
}

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readExplicitCostUsd(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cost = (raw as { cost?: unknown }).cost;
  if (typeof cost === "number") {
    return readFiniteNonNegativeNumber(cost);
  }
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return undefined;
  }
  return (
    readFiniteNonNegativeNumber((cost as { total?: unknown; totalUsd?: unknown }).totalUsd) ??
    readFiniteNonNegativeNumber((cost as { total?: unknown }).total)
  );
}

function buildUsage(params: {
  rawUsage: unknown;
  normalized: NormalizedUsage | undefined;
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): PluginLlmCompleteUsage {
  const costConfig = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.cfg,
  });
  const costUsd =
    readExplicitCostUsd(params.rawUsage) ??
    estimateUsageCost({ usage: params.normalized, cost: costConfig });
  return {
    ...(params.normalized?.input !== undefined ? { inputTokens: params.normalized.input } : {}),
    ...(params.normalized?.output !== undefined ? { outputTokens: params.normalized.output } : {}),
    ...(params.normalized?.cacheRead !== undefined
      ? { cacheReadTokens: params.normalized.cacheRead }
      : {}),
    ...(params.normalized?.cacheWrite !== undefined
      ? { cacheWriteTokens: params.normalized.cacheWrite }
      : {}),
    ...(params.normalized?.total !== undefined ? { totalTokens: params.normalized.total } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function finiteOption(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) {
    return null;
  }
  const normalized = normalizeModelRef(provider, model);
  return `${normalized.provider}/${normalized.model}`;
}

function buildPolicyFromEntry(entry: {
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  hasAllowedModelsConfig?: boolean;
  allowedModels?: readonly string[];
}): RuntimeLlmOverridePolicy {
  const allowedModels = new Set<string>();
  let allowAnyModel = false;
  for (const modelRef of entry.allowedModels ?? []) {
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
  return {
    allowAgentIdOverride: entry.allowAgentIdOverride === true,
    allowModelOverride: entry.allowModelOverride === true,
    hasConfiguredAllowedModels: entry.hasAllowedModelsConfig === true,
    allowAnyModel,
    allowedModels,
  };
}

function resolvePluginLlmOverridePolicy(
  cfg: OpenClawConfig,
  caller: PluginLlmCompleteCaller,
): RuntimeLlmOverridePolicy | undefined {
  if (caller.kind !== "plugin") {
    return undefined;
  }
  const pluginId = normalizeOptionalString(caller.id);
  if (!pluginId) {
    return undefined;
  }
  const entry = normalizePluginsConfig(cfg.plugins).entries[pluginId]?.llm;
  return entry ? buildPolicyFromEntry(entry) : undefined;
}

function resolveAuthorityModelPolicy(
  authority?: RuntimeLlmAuthority,
): RuntimeLlmOverridePolicy | undefined {
  if (
    authority?.allowAgentIdOverride !== true &&
    authority?.allowModelOverride !== true &&
    authority?.allowedModels === undefined
  ) {
    return undefined;
  }
  return buildPolicyFromEntry({
    allowAgentIdOverride: authority.allowAgentIdOverride,
    allowModelOverride: authority.allowModelOverride,
    hasAllowedModelsConfig: authority.allowedModels !== undefined,
    allowedModels: authority.allowedModels,
  });
}

function assertAllowedModelOverride(params: {
  resolvedModelRef: string | null;
  caller: PluginLlmCompleteCaller;
  authorityPolicy: RuntimeLlmOverridePolicy | undefined;
  pluginPolicy: RuntimeLlmOverridePolicy | undefined;
}): void {
  const policy = params.authorityPolicy?.allowModelOverride
    ? params.authorityPolicy
    : params.pluginPolicy?.allowModelOverride
      ? params.pluginPolicy
      : undefined;
  if (!policy) {
    throw new Error("Plugin LLM completion cannot override the target model.");
  }
  if (policy.allowAnyModel) {
    return;
  }
  if (policy.hasConfiguredAllowedModels && policy.allowedModels.size === 0) {
    throw new Error("Plugin LLM completion model override allowlist has no valid models.");
  }
  if (policy.allowedModels.size === 0) {
    return;
  }
  if (!params.resolvedModelRef) {
    throw new Error(
      "Plugin LLM completion model override allowlist requires a resolvable provider/model target.",
    );
  }
  if (!policy.allowedModels.has(params.resolvedModelRef)) {
    const owner =
      params.caller.kind === "plugin" && params.caller.id
        ? ` for plugin "${params.caller.id}"`
        : "";
    throw new Error(
      `Plugin LLM completion model override "${params.resolvedModelRef}" is not allowlisted${owner}.`,
    );
  }
}

/**
 * Create the host-owned generic LLM completion runtime for trusted plugin callers.
 */
export function createRuntimeLlm(options: CreateRuntimeLlmOptions = {}): PluginRuntimeCore["llm"] {
  const logger = options.logger ?? toRuntimeLogger(defaultLogger);
  return {
    complete: async (params: PluginLlmCompleteParams): Promise<PluginLlmCompleteResult> => {
      const caller = resolveTrustedCaller(options.authority);
      if (options.authority?.allowComplete === false) {
        const reason = options.authority.denyReason ?? "capability denied";
        logger.warn("plugin llm completion denied", {
          caller,
          purpose: params.purpose,
          reason,
        });
        throw new Error(`Plugin LLM completion denied: ${reason}`);
      }

      const [
        {
          prepareSimpleCompletionModelForAgent,
          completeWithPreparedSimpleCompletionModel,
          resolveSimpleCompletionSelectionForAgent,
        },
        cfg,
      ] = await Promise.all([
        import("../../agents/simple-completion-runtime.js"),
        Promise.resolve(resolveRuntimeConfig(options)),
      ]);
      const pluginPolicy = resolvePluginLlmOverridePolicy(cfg, caller);
      const authorityPolicy = resolveAuthorityModelPolicy(options.authority);
      const agentId = await resolveAgentId({
        request: params,
        cfg,
        authority: options.authority,
        allowAgentIdOverride:
          authorityPolicy?.allowAgentIdOverride === true ||
          pluginPolicy?.allowAgentIdOverride === true,
      });
      const requestedModel = normalizeOptionalString(params.model);
      if (requestedModel) {
        const selection = resolveSimpleCompletionSelectionForAgent({
          cfg,
          agentId,
          modelRef: requestedModel,
        });
        const normalizedSelection = selection
          ? normalizeModelRef(selection.provider, selection.modelId)
          : null;
        const resolvedModelRef = normalizedSelection
          ? `${normalizedSelection.provider}/${normalizedSelection.model}`
          : null;
        assertAllowedModelOverride({
          resolvedModelRef,
          caller,
          authorityPolicy,
          pluginPolicy,
        });
      }

      const prepared = await prepareSimpleCompletionModelForAgent({
        cfg,
        agentId,
        modelRef: params.model,
        allowMissingApiKeyModes: ["aws-sdk"],
      });

      if ("error" in prepared) {
        throw new Error(`Plugin LLM completion failed: ${prepared.error}`);
      }

      const context = {
        systemPrompt: buildSystemPrompt(params),
        messages: buildMessages({
          request: params,
          provider: prepared.model.provider,
          model: prepared.model.id,
          api: prepared.model.api,
        }),
      };

      const result = await completeWithPreparedSimpleCompletionModel({
        model: prepared.model,
        auth: prepared.auth,
        cfg,
        context,
        options: {
          maxTokens: finiteOption(params.maxTokens),
          temperature: finiteOption(params.temperature),
          signal: params.signal,
        },
      });

      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const normalizedUsage = normalizeUsage(result.usage as UsageLike | undefined);
      const usage = buildUsage({
        rawUsage: result.usage,
        normalized: normalizedUsage,
        cfg,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
      });

      logger.info("plugin llm completion", {
        caller,
        purpose: params.purpose,
        sessionKey: options.authority?.sessionKey,
        agentId,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
        usage,
      });

      return {
        text,
        provider: prepared.selection.provider,
        model: prepared.selection.modelId,
        agentId,
        usage,
        audit: {
          caller,
          ...(params.purpose ? { purpose: params.purpose } : {}),
          ...(options.authority?.sessionKey ? { sessionKey: options.authority.sessionKey } : {}),
        },
      };
    },
  };
}
