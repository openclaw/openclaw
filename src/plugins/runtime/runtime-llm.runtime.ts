// Runtime LLM helpers adapt plugin provider hooks into the core model runtime.
import { asFiniteNumber, asFiniteNumberInRange } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { assertOperatorModelAllowed } from "../../agents/admitted-run-context.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { normalizeModelRef, type ModelRef } from "../../agents/model-ref-shared.js";
import type { UsageLike } from "../../agents/usage.js";
import { hasRecordedUsageCost, normalizeUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { markHostPluginUsageDiagnosticEvent } from "../../infra/diagnostic-plugin-usage-provenance.js";
import type { Api, Message } from "../../llm/types.js";
import { getChildLogger } from "../../logging.js";
import { AsyncWorkScope, captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { modelKey } from "../../shared/model-key.js";
import {
  estimateAggregateUsageCost,
  estimateUsageCost,
  resolveModelCostConfig,
} from "../../utils/usage-format.js";
import { createLlmCompleteError as completionError } from "./runtime-llm-error.js";
import {
  assertSupportedExecutionMode,
  isIsolatedAgentRuntimeRequest,
  runIsolatedAgentRuntimeCompletion,
} from "./runtime-llm-isolated.js";
import { bindLlmOperatorAuthority } from "./runtime-llm-operator-authority.js";
import { writeRuntimeLog } from "./runtime-logging.js";
import {
  assertAllowedAuthProfileOverride,
  assertAllowedCompletionModel,
  assertAllowedModelOverride,
  resolveAllowAgentIdOverride,
  resolveAuthorityModelPolicy,
  resolvePluginLlmPolicy,
  resolvePluginPolicyId,
  resolveRequestedRuntimeAgentId,
  resolveTrustedCaller,
  type RuntimeLlmAuthority,
} from "./runtime-model-policy.js";
import type {
  LlmCompleteParams,
  LlmCompleteResult,
  LlmCompleteUsage,
  PluginRuntimeCore,
  RuntimeLogger,
} from "./types-core.js";

export type CreateRuntimeLlmOptions = {
  getConfig?: () => OpenClawConfig | undefined;
  authority?: RuntimeLlmAuthority;
  logger?: RuntimeLogger;
};

const defaultLogger = getChildLogger({ capability: "runtime.llm" });

function toRuntimeLogger(logger: typeof defaultLogger): RuntimeLogger {
  return {
    debug: (message, meta) => writeRuntimeLog(logger, "debug", message, meta),
    info: (message, meta) => writeRuntimeLog(logger, "info", message, meta),
    warn: (message, meta) => writeRuntimeLog(logger, "warn", message, meta),
    error: (message, meta) => writeRuntimeLog(logger, "error", message, meta),
  };
}

function resolveRuntimeConfig(options: CreateRuntimeLlmOptions): OpenClawConfig {
  const cfg = options.getConfig?.();
  if (!cfg) {
    throw new Error("Plugin LLM completion requires an injected runtime config scope.");
  }
  return cfg;
}

async function resolveAgentId(params: {
  request: LlmCompleteParams;
  cfg: OpenClawConfig;
  authority?: RuntimeLlmAuthority;
  allowAgentIdOverride: boolean;
}): Promise<string> {
  const agentId = resolveRequestedRuntimeAgentId({
    agentId: params.request.agentId,
    authority: params.authority,
    allowAgentIdOverride: params.allowAgentIdOverride,
  });
  if (agentId) {
    return agentId;
  }
  const { resolveAmbientOwnerAgentId } = await import("../../agents/agent-scope.js");
  return resolveAmbientOwnerAgentId(params.cfg);
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
  return asFiniteNumberInRange(value, { min: 0 });
}

function readExplicitCostUsd(raw: unknown): number | undefined {
  const cost = asOptionalRecord(raw)?.cost;
  if (typeof cost === "number") {
    return readFiniteNonNegativeNumber(cost);
  }
  const record = asOptionalRecord(cost);
  if (!record) {
    return undefined;
  }
  return (
    readFiniteNonNegativeNumber(record.totalUsd) ??
    (hasRecordedUsageCost(record) ? readFiniteNonNegativeNumber(record.total) : undefined)
  );
}

export function finalizePluginLlmCompletion(params: {
  cfg: OpenClawConfig;
  hostPluginId?: string;
  suppressUsage?: boolean;
  rawUsage: unknown;
  logger?: RuntimeLogger;
  result: Omit<LlmCompleteResult, "usage">;
}): LlmCompleteResult {
  const normalized = normalizeUsage(params.rawUsage as UsageLike | undefined);
  const costConfig = resolveModelCostConfig({
    provider: params.result.provider,
    model: params.result.model,
    config: params.cfg,
  });
  // Isolated runtimes may report a whole run; only direct calls retain tier boundaries here.
  const estimateCost =
    params.result.execution.mode === "direct-provider"
      ? estimateUsageCost
      : estimateAggregateUsageCost;
  const costUsd =
    readExplicitCostUsd(params.rawUsage) ?? estimateCost({ usage: normalized, cost: costConfig });
  const usage: LlmCompleteUsage = {
    ...(normalized?.input !== undefined ? { inputTokens: normalized.input } : {}),
    ...(normalized?.output !== undefined ? { outputTokens: normalized.output } : {}),
    ...(normalized?.cacheRead !== undefined ? { cacheReadTokens: normalized.cacheRead } : {}),
    ...(normalized?.cacheWrite !== undefined ? { cacheWriteTokens: normalized.cacheWrite } : {}),
    ...(normalized?.total !== undefined ? { totalTokens: normalized.total } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  const logger = params.logger ?? toRuntimeLogger(defaultLogger);
  logger.info("plugin llm completion", {
    caller: params.result.audit.caller,
    purpose: params.result.audit.purpose,
    sessionKey: params.result.audit.sessionKey,
    agentId: params.result.agentId,
    provider: params.result.provider,
    model: params.result.model,
    executionMode: params.result.execution.mode,
    executionOwner: params.result.execution.owner,
    usage,
  });
  const input = normalized?.input ?? 0;
  const output = normalized?.output ?? 0;
  const cacheRead = normalized?.cacheRead ?? 0;
  const cacheWrite = normalized?.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  const total = normalized?.total ?? promptTokens + output;
  const hasPositiveUsage = [input, output, cacheRead, cacheWrite, total, usage.costUsd].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (params.suppressUsage !== true && isDiagnosticsEnabled(params.cfg) && hasPositiveUsage) {
    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent(
        {
          type: "model.usage",
          ...(params.result.audit.sessionKey ? { sessionKey: params.result.audit.sessionKey } : {}),
          agentId: params.result.agentId,
          provider: params.result.provider,
          model: params.result.model,
          usage: {
            input,
            output,
            cacheRead,
            cacheWrite,
            promptTokens,
            total,
          },
          ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        },
        params.hostPluginId,
      ),
    );
  }
  return { ...params.result, usage };
}

/**
 * Create the host-owned generic LLM completion runtime for trusted plugin callers.
 */
export function createRuntimeLlm(
  options: CreateRuntimeLlmOptions = {},
): Pick<PluginRuntimeCore["llm"], "complete"> {
  const logger = options.logger ?? toRuntimeLogger(defaultLogger);
  return {
    complete: bindLlmOperatorAuthority(options.authority?.caller, async (params, source) => {
      const caller = resolveTrustedCaller(options.authority);
      if (options.authority?.allowComplete === false) {
        const reason = options.authority.denyReason ?? "capability denied";
        logger.warn("plugin llm completion denied", {
          caller,
          purpose: params.purpose,
          reason,
        });
        throw completionError(
          "LLM_COMPLETION_NOT_AUTHORIZED",
          `Plugin LLM completion denied: ${reason}`,
        );
      }
      assertSupportedExecutionMode(params);
      const { operatorAuthority, signal: requestSignal, assertCurrent } = source;
      assertCurrent();

      const [
        {
          acquireSimpleCompletionModelForAgent,
          completeWithPreparedSimpleCompletionModel,
          resolveSimpleCompletionSelectionForAgent,
        },
        cfg,
      ] = await Promise.all([
        import("../../agents/simple-completion-runtime.js"),
        Promise.resolve(resolveRuntimeConfig(options)),
      ]);
      const pluginPolicyId = resolvePluginPolicyId(options.authority, caller);
      const pluginPolicy = resolvePluginLlmPolicy(cfg, pluginPolicyId);
      const authorityPolicy = resolveAuthorityModelPolicy(options.authority);
      const preferredProfile = normalizeOptionalString(options.authority?.preferredProfile);
      const audit = {
        caller,
        ...(params.purpose ? { purpose: params.purpose } : {}),
        ...(options.authority?.sessionKey ? { sessionKey: options.authority.sessionKey } : {}),
      };
      const agentId = await resolveAgentId({
        request: params,
        cfg,
        authority: options.authority,
        allowAgentIdOverride: resolveAllowAgentIdOverride({
          authority: options.authority,
          authorityPolicy,
          pluginPolicy,
        }),
      });
      const requestedModel = normalizeOptionalString(params.model);
      const requestedModelProfile = requestedModel
        ? normalizeOptionalString(splitTrailingAuthProfile(requestedModel).profile)
        : undefined;
      const selection = resolveSimpleCompletionSelectionForAgent({
        cfg,
        agentId,
        modelRef: requestedModel,
      });
      if (!selection) {
        throw completionError("LLM_COMPLETION_FAILED", `No model configured for agent ${agentId}.`);
      }
      const normalizedSelection = normalizeModelRef(selection.provider, selection.modelId);
      assertCurrent();
      assertOperatorModelAllowed(operatorAuthority, normalizedSelection);
      const resolvedModelRef = modelKey(normalizedSelection.provider, normalizedSelection.model);
      assertAllowedCompletionModel({
        resolvedModelRef,
        authorityPolicy,
        pluginPolicy,
        pluginPolicyId,
      });
      if (requestedModel) {
        assertAllowedModelOverride({
          resolvedModelRef,
          pluginPolicyId,
          authorityPolicy,
          pluginPolicy,
        });
      }

      const isolatedRequest = isIsolatedAgentRuntimeRequest(params);
      const executionProfile = isolatedRequest
        ? normalizeOptionalString(params.execution.authProfileId)
        : undefined;
      const modelProfile = normalizeOptionalString(selection.profileId);
      if (executionProfile && requestedModelProfile && executionProfile !== requestedModelProfile) {
        throw completionError(
          "LLM_ISOLATED_INPUT_REJECTED",
          "Isolated completion received conflicting auth profiles in model and execution.authProfileId.",
        );
      }

      if (isolatedRequest) {
        // Direct completions preserve the shipped model@profile contract under model
        // override authority. Isolated credential routing requires separate authority.
        assertAllowedAuthProfileOverride({
          authProfileId: executionProfile ?? requestedModelProfile,
          authorityPolicy,
          pluginPolicy,
        });
        const result = await runIsolatedAgentRuntimeCompletion({
          request: requestSignal === params.signal ? params : { ...params, signal: requestSignal },
          cfg,
          agentId,
          provider: selection.provider,
          model: selection.modelId,
          // Request-authorized profiles win, then the host/session binding. Only
          // an unbound call may fall back to the agent's configured selection.
          authProfileId:
            executionProfile ?? requestedModelProfile ?? preferredProfile ?? modelProfile,
          operatorAuthority,
          assertCurrent,
        });
        assertCurrent();
        return finalizePluginLlmCompletion({
          cfg,
          hostPluginId: pluginPolicyId,
          rawUsage: result.usage,
          logger,
          result: {
            text: result.text,
            provider: result.provider,
            model: result.model,
            agentId,
            execution: { mode: params.execution.mode, owner: result.owner },
            audit,
          },
        });
      }

      const callerResult = createDeferredCore<LlmCompleteResult>();
      const trackOwner = captureAsyncWorkTracker();
      // Admit drainage with the parent before acquisition; the caller only waits for its result.
      void trackOwner(async () => {
        assertCurrent();
        let preparedLogicalModel: ModelRef | undefined;
        const preparation = await acquireSimpleCompletionModelForAgent({
          cfg,
          agentId,
          modelRef: params.model,
          preferredProfile,
          ...(requestedModelProfile ? { bindAuthOwner: true } : {}),
          allowBundledStaticCatalogFallback: true,
          allowMissingApiKeyModes: ["aws-sdk"],
          skipAgentDiscovery: true,
          signal: requestSignal,
          modelResolver: operatorAuthority
            ? async (...args) => {
                const { resolveModelAsync } =
                  await import("../../agents/embedded-agent-runner/model.js");
                assertCurrent();
                const resolved = await resolveModelAsync(...args);
                if (resolved.model) {
                  preparedLogicalModel = resolved.logicalRef;
                  assertOperatorModelAllowed(operatorAuthority, preparedLogicalModel);
                }
                return resolved;
              }
            : undefined,
        });

        if ("error" in preparation) {
          throw new Error(`Plugin LLM completion failed: ${preparation.error}`);
        }
        await using prepared = preparation;
        const modelExecution = source.bindModelExecution(
          preparedLogicalModel ?? {
            provider: prepared.selection.provider,
            model: prepared.selection.modelId,
          },
        );
        const modelSignal = modelExecution
          ? requestSignal
            ? AbortSignal.any([requestSignal, modelExecution.signal])
            : modelExecution.signal
          : requestSignal;
        const assertPreparedCurrent = () => {
          assertCurrent();
          modelExecution?.assertCurrent();
        };
        assertPreparedCurrent();

        const work = new AsyncWorkScope();
        try {
          callerResult.resolve(
            await work.track(async () => {
              if (params.requiredAuthMode && prepared.auth.mode !== params.requiredAuthMode) {
                throw completionError(
                  "LLM_COMPLETION_NOT_AUTHORIZED",
                  "Plugin LLM completion selected a credential with the wrong authentication mode.",
                );
              }
              if (requestedModelProfile && prepared.auth.profileId !== requestedModelProfile) {
                throw completionError(
                  "LLM_COMPLETION_NOT_AUTHORIZED",
                  "Plugin LLM completion selected a different authentication profile.",
                );
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
                assertCurrent: assertPreparedCurrent,
                model: prepared.model,
                auth: prepared.auth,
                cfg,
                context,
                options: {
                  maxTokens: asFiniteNumber(params.maxTokens),
                  temperature: asFiniteNumber(params.temperature),
                  ...(params.responseFormat !== undefined
                    ? { responseFormat: params.responseFormat }
                    : {}),
                  ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
                  signal: modelSignal,
                },
              });
              assertPreparedCurrent();

              const text = result.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("");
              return finalizePluginLlmCompletion({
                cfg,
                hostPluginId: pluginPolicyId,
                // Provider failures resolve as messages; only visible successful output owns usage.
                suppressUsage:
                  !text.trim() || !["stop", "length", "toolUse"].includes(result.stopReason),
                rawUsage: result.usage,
                logger,
                result: {
                  text,
                  provider: prepared.selection.provider,
                  model: prepared.selection.modelId,
                  responseModel: result.responseModel,
                  stopReason: result.stopReason,
                  agentId,
                  execution: {
                    mode: "direct-provider",
                    owner: { kind: "provider", id: prepared.selection.provider },
                  },
                  audit,
                },
              });
            }),
          );
        } catch (error) {
          callerResult.reject(error);
        } finally {
          await work.drain();
        }
      }).catch((error: unknown) => callerResult.reject(error));
      return await callerResult.promise;
    }),
  };
}
