import type { Api, Message } from "@earendil-works/pi-ai";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { normalizeModelRef } from "../../agents/model-selection.js";
import type { NormalizedUsage, UsageLike } from "../../agents/usage.js";
import { normalizeUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getChildLogger } from "../../logging.js";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "../../plugin-sdk/json-schema-runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { normalizePluginsConfig } from "../config-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type {
  LlmCompleteCaller,
  LlmCompleteParams,
  LlmCompleteResult,
  LlmCompleteStructuredInput,
  LlmCompleteStructuredParams,
  LlmCompleteStructuredResult,
  LlmCompleteUsage,
  PluginRuntimeCore,
  RuntimeLogger,
} from "./types-core.js";

export type RuntimeLlmAuthority = {
  caller?: LlmCompleteCaller;
  /** Trusted host-derived plugin id used only for config policy lookup. */
  pluginIdForPolicy?: string;
  sessionKey?: string;
  agentId?: string;
  requiresBoundAgent?: boolean;
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  allowProfileOverride?: boolean;
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
  allowProfileOverride: boolean;
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
  caller?: LlmCompleteCaller,
  fallback?: LlmCompleteCaller,
): LlmCompleteCaller {
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

function resolveTrustedCaller(authority?: RuntimeLlmAuthority): LlmCompleteCaller {
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
  request: Pick<LlmCompleteParams, "agentId">;
  cfg: OpenClawConfig;
  authority?: RuntimeLlmAuthority;
  allowAgentIdOverride: boolean;
}): Promise<string> {
  const authorityAgentIdRaw = normalizeOptionalString(params.authority?.agentId);
  const requestedAgentIdRaw = normalizeOptionalString(params.request.agentId);
  const authorityAgentId = authorityAgentIdRaw ? normalizeAgentId(authorityAgentIdRaw) : undefined;
  const requestedAgentId = requestedAgentIdRaw ? normalizeAgentId(requestedAgentIdRaw) : undefined;
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

function buildSystemPrompt(params: LlmCompleteParams): string | undefined {
  const segments = [
    normalizeOptionalString(params.systemPrompt),
    ...params.messages
      .filter((message) => message.role === "system")
      .map((message) => normalizeOptionalString(message.content)),
  ].filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? (match[1] ?? "").trim() : trimmed;
}

function buildStructuredInstructions(params: LlmCompleteStructuredParams): string {
  const sections = [params.instructions.trim()];
  if (normalizeOptionalString(params.schemaName)) {
    sections.push(`Schema name: ${params.schemaName!.trim()}`);
  }
  if (params.jsonSchema !== undefined) {
    sections.push(`JSON schema:\n${JSON.stringify(params.jsonSchema)}`);
  }
  if (shouldUseJsonMode(params)) {
    sections.push("Return valid JSON only. Do not wrap the JSON in Markdown fences.");
  }
  return sections.join("\n\n");
}

function shouldUseJsonMode(
  params: Pick<LlmCompleteStructuredParams, "jsonMode" | "jsonSchema">,
): boolean {
  return params.jsonMode === true || params.jsonSchema !== undefined;
}

function hasImageInput(input: LlmCompleteStructuredInput[]): boolean {
  return input.some((entry) => entry.type === "image");
}

function buildStructuredMessages(params: { request: LlmCompleteStructuredParams }): Message[] {
  const now = Date.now();
  return [
    {
      role: "user" as const,
      timestamp: now,
      content: [
        { type: "text" as const, text: buildStructuredInstructions(params.request) },
        ...params.request.input.map((entry) =>
          entry.type === "text"
            ? { type: "text" as const, text: entry.text }
            : {
                type: "image" as const,
                data: entry.buffer.toString("base64"),
                mimeType: normalizeOptionalString(entry.mimeType) ?? "image/png",
              },
        ),
      ],
    },
  ];
}

function createCompletionSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal, cleanup: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Plugin LLM completion timed out")),
    timeoutMs,
  );
  timer.unref?.();
  let detachParentAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      detachParentAbort = () => signal.removeEventListener("abort", onAbort);
    }
  }
  return {
    signal:
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
        : controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      detachParentAbort?.();
    },
  };
}

function parseStructuredText(params: { text: string; jsonMode: boolean; jsonSchema?: unknown }): {
  parsed?: unknown;
  contentType: "json" | "text";
} {
  if (!params.jsonMode) {
    return { contentType: "text" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(params.text));
  } catch {
    throw new Error("Plugin LLM structured completion returned invalid JSON.");
  }
  if (
    params.jsonSchema &&
    typeof params.jsonSchema === "object" &&
    !Array.isArray(params.jsonSchema)
  ) {
    const validation = validateJsonSchemaValue({
      schema: params.jsonSchema as JsonSchemaObject,
      cacheKey: "runtime.llm.completeStructured",
      value: parsed,
      cache: false,
    });
    if (!validation.ok) {
      const message =
        validation.errors.map((entry) => entry.text).join("; ") || "invalid structured JSON";
      throw new Error(`Plugin LLM structured completion JSON did not match schema: ${message}`);
    }
  }
  return { parsed, contentType: "json" };
}

function buildMessages(params: {
  request: LlmCompleteParams;
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
}): LlmCompleteUsage {
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

function modelSupportsImageInput(model: { input?: unknown }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function normalizeResolvedSelectionModelRef(
  selection:
    | {
        provider: string;
        modelId: string;
      }
    | null
    | undefined,
): string | null {
  if (!selection) {
    return null;
  }
  const normalized = normalizeModelRef(selection.provider, selection.modelId);
  return `${normalized.provider}/${normalized.model}`;
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
  allowProfileOverride?: boolean;
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
    allowProfileOverride: entry.allowProfileOverride === true,
    hasConfiguredAllowedModels: entry.hasAllowedModelsConfig === true,
    allowAnyModel,
    allowedModels,
  };
}

function resolvePluginPolicyId(
  authority: RuntimeLlmAuthority | undefined,
  caller: LlmCompleteCaller,
): string | undefined {
  const authorityPluginId = normalizeOptionalString(authority?.pluginIdForPolicy);
  if (authorityPluginId) {
    return authorityPluginId;
  }
  if (caller.kind !== "plugin") {
    return undefined;
  }
  const pluginId = normalizeOptionalString(caller.id);
  return pluginId;
}

function resolvePluginLlmOverridePolicy(
  cfg: OpenClawConfig,
  pluginId: string | undefined,
): RuntimeLlmOverridePolicy | undefined {
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
    authority?.allowProfileOverride !== true &&
    authority?.allowedModels === undefined
  ) {
    return undefined;
  }
  return buildPolicyFromEntry({
    allowAgentIdOverride: authority.allowAgentIdOverride,
    allowModelOverride: authority.allowModelOverride,
    allowProfileOverride: authority.allowProfileOverride,
    hasAllowedModelsConfig: authority.allowedModels !== undefined,
    allowedModels: authority.allowedModels,
  });
}

function assertAllowedProfileOverride(params: {
  requestedProfile: string | undefined;
  pluginPolicyId: string | undefined;
  authorityPolicy: RuntimeLlmOverridePolicy | undefined;
  pluginPolicy: RuntimeLlmOverridePolicy | undefined;
}): void {
  if (!params.requestedProfile) {
    return;
  }
  if (params.authorityPolicy?.allowProfileOverride) {
    return;
  }
  if (params.pluginPolicy?.allowProfileOverride) {
    return;
  }
  const owner = params.pluginPolicyId ? ` for plugin "${params.pluginPolicyId}"` : "";
  throw new Error(`Plugin LLM completion cannot override the auth profile${owner}.`);
}

function hasAllowedProfileOverride(params: {
  authorityPolicy: RuntimeLlmOverridePolicy | undefined;
  pluginPolicy: RuntimeLlmOverridePolicy | undefined;
}): boolean {
  return (
    params.authorityPolicy?.allowProfileOverride === true ||
    params.pluginPolicy?.allowProfileOverride === true
  );
}

function assertAllowedModelOverride(params: {
  resolvedModelRef: string | null;
  pluginPolicyId: string | undefined;
  authorityPolicy: RuntimeLlmOverridePolicy | undefined;
  pluginPolicy: RuntimeLlmOverridePolicy | undefined;
}): void {
  let policy: RuntimeLlmOverridePolicy | undefined;
  let policyOwnerPluginId: string | undefined;
  if (params.authorityPolicy?.allowModelOverride) {
    policy = params.authorityPolicy;
  } else if (params.pluginPolicy?.allowModelOverride) {
    policy = params.pluginPolicy;
    policyOwnerPluginId = params.pluginPolicyId;
  }
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
    const owner = policyOwnerPluginId ? ` for plugin "${policyOwnerPluginId}"` : "";
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
  async function prepareRuntimeCall(params: {
    model?: string;
    agentId?: string;
    profile?: string;
    preferImageModel?: boolean;
  }) {
    const caller = resolveTrustedCaller(options.authority);
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
    const pluginPolicyId = resolvePluginPolicyId(options.authority, caller);
    const pluginPolicy = resolvePluginLlmOverridePolicy(cfg, pluginPolicyId);
    const authorityPolicy = resolveAuthorityModelPolicy(options.authority);
    const agentId = await resolveAgentId({
      request: params,
      cfg,
      authority: options.authority,
      allowAgentIdOverride:
        options.authority?.allowAgentIdOverride === false
          ? false
          : authorityPolicy?.allowAgentIdOverride === true ||
            pluginPolicy?.allowAgentIdOverride === true,
    });
    const requestedModel = normalizeOptionalString(params.model);
    const splitRequestedModel = requestedModel
      ? splitTrailingAuthProfile(requestedModel)
      : { model: undefined, profile: undefined };
    const requestedModelRef = normalizeOptionalString(splitRequestedModel.model);
    const requestedProfileFromModel = normalizeOptionalString(splitRequestedModel.profile);
    const requestedProfile = normalizeOptionalString(params.profile);
    if (
      requestedProfile &&
      requestedProfileFromModel &&
      requestedProfile !== requestedProfileFromModel
    ) {
      throw new Error(
        "Plugin LLM completion received conflicting auth profiles in model and profile fields.",
      );
    }
    const effectiveRequestedProfile = requestedProfile ?? requestedProfileFromModel;
    let effectiveRequestedModelRef = requestedModelRef;
    let modelRefProfileCoveredByModelOverride = false;
    if (requestedModelRef) {
      const selection = resolveSimpleCompletionSelectionForAgent({
        cfg,
        agentId,
        modelRef: requestedModelRef,
      });
      const defaultSelection = resolveSimpleCompletionSelectionForAgent({
        cfg,
        agentId,
      });
      const resolvedModelRef = normalizeResolvedSelectionModelRef(selection);
      const defaultResolvedModelRef = normalizeResolvedSelectionModelRef(defaultSelection);
      const changesTargetModel =
        defaultResolvedModelRef === null || resolvedModelRef !== defaultResolvedModelRef;
      if (changesTargetModel) {
        assertAllowedModelOverride({
          resolvedModelRef,
          pluginPolicyId,
          authorityPolicy,
          pluginPolicy,
        });
        modelRefProfileCoveredByModelOverride = requestedProfileFromModel !== undefined;
      } else {
        if (
          requestedProfileFromModel &&
          !hasAllowedProfileOverride({ authorityPolicy, pluginPolicy })
        ) {
          assertAllowedModelOverride({
            resolvedModelRef,
            pluginPolicyId,
            authorityPolicy,
            pluginPolicy,
          });
          modelRefProfileCoveredByModelOverride = true;
        }
        effectiveRequestedModelRef = undefined;
      }
    }
    if (requestedProfile) {
      assertAllowedProfileOverride({
        requestedProfile,
        pluginPolicyId,
        authorityPolicy,
        pluginPolicy,
      });
    } else if (requestedProfileFromModel && !modelRefProfileCoveredByModelOverride) {
      assertAllowedProfileOverride({
        requestedProfile: requestedProfileFromModel,
        pluginPolicyId,
        authorityPolicy,
        pluginPolicy,
      });
    }

    let hostResolvedModelRef = effectiveRequestedModelRef;
    if (!hostResolvedModelRef && params.preferImageModel) {
      const [{ resolveAutoImageModel }, { resolveAgentDir }] = await Promise.all([
        import("../../media-understanding/runner.js"),
        import("../../agents/agent-scope.js"),
      ]);
      const imageModel = await resolveAutoImageModel({
        cfg,
        agentDir: resolveAgentDir(cfg, agentId),
      });
      if (imageModel?.provider && imageModel?.model) {
        hostResolvedModelRef = `${imageModel.provider}/${imageModel.model}`;
      }
    }

    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId,
      modelRef: hostResolvedModelRef,
      preferredProfile: effectiveRequestedProfile,
      allowMissingApiKeyModes: ["aws-sdk"],
    });

    if ("error" in prepared) {
      throw new Error(`Plugin LLM completion failed: ${prepared.error}`);
    }

    return {
      caller,
      cfg,
      agentId,
      prepared,
      completeWithPreparedSimpleCompletionModel,
    };
  }

  return {
    complete: async (params: LlmCompleteParams): Promise<LlmCompleteResult> => {
      if (options.authority?.allowComplete === false) {
        const reason = options.authority.denyReason ?? "capability denied";
        logger.warn("plugin llm completion denied", {
          caller: resolveTrustedCaller(options.authority),
          purpose: params.purpose,
          reason,
        });
        throw new Error(`Plugin LLM completion denied: ${reason}`);
      }
      const { caller, cfg, agentId, prepared, completeWithPreparedSimpleCompletionModel } =
        await prepareRuntimeCall(params);

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
    completeStructured: async (
      params: LlmCompleteStructuredParams,
    ): Promise<LlmCompleteStructuredResult> => {
      if (options.authority?.allowComplete === false) {
        const reason = options.authority.denyReason ?? "capability denied";
        logger.warn("plugin llm structured completion denied", {
          caller: resolveTrustedCaller(options.authority),
          purpose: params.purpose,
          reason,
        });
        throw new Error(`Plugin LLM structured completion denied: ${reason}`);
      }
      if (params.input.length === 0) {
        throw new Error("Plugin LLM structured completion requires at least one input.");
      }
      if (!params.instructions.trim()) {
        throw new Error("Plugin LLM structured completion requires instructions.");
      }

      const imageInput = hasImageInput(params.input);
      const { caller, cfg, agentId, prepared, completeWithPreparedSimpleCompletionModel } =
        await prepareRuntimeCall({
          ...params,
          preferImageModel: imageInput,
        });
      if (imageInput && !modelSupportsImageInput(prepared.model)) {
        throw new Error(
          `Plugin LLM structured completion model does not support image input: ${prepared.selection.provider}/${prepared.selection.modelId}`,
        );
      }

      const { signal, cleanup } = createCompletionSignal(
        params.signal,
        finiteOption(params.timeoutMs),
      );
      try {
        const result = await completeWithPreparedSimpleCompletionModel({
          model: prepared.model,
          auth: prepared.auth,
          cfg,
          context: {
            systemPrompt: normalizeOptionalString(params.systemPrompt),
            messages: buildStructuredMessages({ request: params }),
          },
          options: {
            maxTokens: finiteOption(params.maxTokens),
            temperature: finiteOption(params.temperature),
            signal,
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
        const structured = parseStructuredText({
          text,
          jsonMode: shouldUseJsonMode(params),
          jsonSchema: params.jsonSchema,
        });

        logger.info("plugin llm structured completion", {
          caller,
          purpose: params.purpose,
          sessionKey: options.authority?.sessionKey,
          agentId,
          provider: prepared.selection.provider,
          model: prepared.selection.modelId,
          usage,
          contentType: structured.contentType,
          imageInput,
        });

        return {
          text,
          provider: prepared.selection.provider,
          model: prepared.selection.modelId,
          agentId,
          usage,
          parsed: structured.parsed,
          contentType: structured.contentType,
          audit: {
            caller,
            ...(params.purpose ? { purpose: params.purpose } : {}),
            ...(options.authority?.sessionKey ? { sessionKey: options.authority.sessionKey } : {}),
          },
        };
      } finally {
        cleanup();
      }
    },
  };
}
