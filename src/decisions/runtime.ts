import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { resolveDecisionModelSetting } from "../agents/decision-model-setting.js";
import { normalizeModelRef } from "../agents/model-ref-shared.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { withPluginHostCleanupTimeout } from "../plugins/host-hook-cleanup-timeout.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  getPluginRegistryResourceOwner,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { createLlmCompleteError } from "../plugins/runtime/runtime-llm-error.js";
import { bindLlmOperatorAuthority } from "../plugins/runtime/runtime-llm-operator-authority.js";
import {
  assertAllowedCompletionModel,
  resolveAllowAgentIdOverride,
  resolveAuthorityModelPolicy,
  resolvePluginLlmPolicy,
  resolveRequestedRuntimeAgentId,
  type RuntimeLlmAuthority,
} from "../plugins/runtime/runtime-model-policy.js";
import { finalizePluginModelUsage } from "../plugins/runtime/runtime-model-usage.js";
import { modelKey } from "../shared/model-key.js";
import { decisionBatchV1ToV2, decisionResultV2ToV1 } from "./compatibility.js";
import type { DecisionProviderHost } from "./provider-host.js";
import type {
  DecisionEvaluateOptionsV2,
  DecisionBatchV2,
  DecisionOutcomeV2,
  DecisionRuntimeV2,
} from "./types-v2.js";
import type { DecisionBatch, DecisionOutcome, DecisionRuntimeV1 } from "./types.js";
import { validateDecisionBatchV2 } from "./validation-v2.js";
import { DecisionContractError } from "./validation.js";

type DecisionExecution = DecisionEvaluateOptionsV2 & { batch: DecisionBatchV2 };

type Options = Parameters<DecisionRuntimeV1["evaluate"]>[1];

function validateOptions(options: Options): void {
  if (
    !options ||
    (options.agentId !== undefined &&
      (typeof options.agentId !== "string" || !options.agentId.trim())) ||
    typeof options.purpose !== "string" ||
    !options.purpose ||
    options.purpose.length > 128 ||
    typeof options.rubricVersion !== "string" ||
    !options.rubricVersion ||
    options.rubricVersion.length > 128 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !(options.signal instanceof AbortSignal)
  ) {
    throw new DecisionContractError();
  }
  options.signal.throwIfAborted();
}

/** Public V1 convenience adapter; it does not own selection, authorization or dispatch. */
export async function evaluateDecision(
  batch: DecisionBatch,
  options: Options,
): Promise<DecisionOutcome> {
  return evaluateDecisionInRegistry(
    batch,
    options,
    getPluginRegistryForContext(),
    getRuntimeConfig(),
  );
}

export async function evaluateDecisionInRegistry(
  batch: DecisionBatch,
  options: Options,
  registry: PluginRegistry | null,
  config: OpenClawConfig,
  consumerId?: string,
): Promise<DecisionOutcome> {
  validateOptions(options);
  const converted = decisionBatchV1ToV2(batch);
  if (!converted) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  // Preserve the admitted evidence for legacy result narrowing after asynchronous execution.
  const input = structuredClone(converted);
  const outcome = await executeDecisionInRegistry(
    {
      batch: input,
      agentId: options.agentId,
      purpose: options.purpose,
      rubricVersion: options.rubricVersion,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    },
    registry,
    config,
    consumerId
      ? { caller: { kind: "plugin", id: consumerId }, pluginIdForPolicy: consumerId }
      : { agentId: options.agentId },
    1,
  );
  if (outcome.status !== "ok") {
    return outcome;
  }
  const result = decisionResultV2ToV1(input, outcome.result);
  // A legacy result cannot silently discard abstention, partial errors, or billing semantics.
  return result ? { ...outcome, result } : { status: "unavailable", reason: "unsupported-input" };
}

export async function evaluateDecisionV2(
  batch: DecisionBatchV2,
  options: DecisionEvaluateOptionsV2,
): Promise<DecisionOutcomeV2> {
  return evaluateDecisionV2InRegistry(
    batch,
    options,
    getPluginRegistryForContext(),
    getRuntimeConfig(),
    { agentId: options.agentId },
  );
}

/** Richer evaluation remains a decision SDK operation, not a chat completion. */
export async function evaluateDecisionV2InRegistry(
  batch: DecisionBatchV2,
  options: DecisionEvaluateOptionsV2,
  registry: PluginRegistry | null,
  config: OpenClawConfig,
  authority?: RuntimeLlmAuthority,
): Promise<DecisionOutcomeV2> {
  validateOptions(options);
  if (
    Object.keys(options).some(
      (key) =>
        !["agentId", "purpose", "rubricVersion", "timeoutMs", "signal", "reasoning"].includes(key),
    )
  ) {
    throw new DecisionContractError();
  }
  return executeDecisionInRegistry({ ...options, batch }, registry, config, authority);
}

/** Internal host issuance only. Plugins receive the resulting bound decision operation. */
export function createHostDecisionEvaluator(options: {
  authority: RuntimeLlmAuthority;
  getConfig?: () => OpenClawConfig;
  getRegistry?: () => PluginRegistry | null;
}): DecisionRuntimeV2["evaluateV2"] {
  return (batch, params) =>
    evaluateDecisionV2InRegistry(
      batch,
      params,
      (options.getRegistry ?? getPluginRegistryForContext)(),
      (options.getConfig ?? getRuntimeConfig)(),
      options.authority,
    );
}

/** Shared internal execution owner used by both versioned decision frontends. */
async function executeDecisionInRegistry(
  params: DecisionExecution,
  registry: PluginRegistry | null,
  config: OpenClawConfig,
  authority?: RuntimeLlmAuthority,
  resultVersion: 1 | 2 = 2,
): Promise<DecisionOutcomeV2> {
  validateOptions(params);
  if (
    Object.keys(params).some(
      (key) =>
        ![
          "batch",
          "agentId",
          "purpose",
          "rubricVersion",
          "timeoutMs",
          "signal",
          "reasoning",
        ].includes(key),
    )
  ) {
    throw new DecisionContractError();
  }
  if (params.reasoning !== undefined && !["auto", "off", "on"].includes(params.reasoning)) {
    throw new DecisionContractError();
  }
  if (authority?.allowComplete === false) {
    throw createLlmCompleteError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin model inference denied by its host capability.",
    );
  }
  if (!validateDecisionBatchV2(params.batch)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const deadline = performance.now() + Math.min(params.timeoutMs, 30_000);
  const consumerId = authority?.pluginIdForPolicy;
  const pluginPolicy = resolvePluginLlmPolicy(config, consumerId);
  const authorityPolicy = resolveAuthorityModelPolicy(authority);
  const agentId = resolveRequestedRuntimeAgentId({
    agentId: params.agentId,
    authority,
    allowAgentIdOverride: resolveAllowAgentIdOverride({ authority, authorityPolicy, pluginPolicy }),
  });
  // A bound host chooses its agent; an omitted unbound SDK request selects the global purpose.
  const selected = resolveDecisionModelSetting(config, agentId);
  if (!selected || config.plugins?.enabled === false) {
    return { status: "unavailable", reason: "disabled" };
  }
  return bindLlmOperatorAuthority(
    authority?.caller,
    async (request: DecisionExecution, source): Promise<DecisionOutcomeV2> => {
      source.assertCurrent();
      const normalizedSelection = normalizeModelRef(selected.provider, selected.model, {
        allowPluginNormalization: false,
        manifestPlugins: getProcessGatewayPluginMetadataSnapshot() ?? [],
      });
      const execution = source.bindModelExecution(normalizedSelection);
      assertAllowedCompletionModel({
        resolvedModelRef: modelKey(normalizedSelection.provider, normalizedSelection.model),
        pluginPolicyId: consumerId,
        pluginPolicy,
        authorityPolicy,
      });
      const entry = registry?.decisionProviders.find(
        (candidate) => candidate.host.provider.id === normalizedSelection.provider,
      );
      if (!entry || !registry) {
        return { status: "unavailable", reason: "not-configured" };
      }
      if (config.plugins?.entries?.[entry.pluginId]?.enabled === false) {
        return entry.host.unavailable("disabled");
      }
      const modelSignal = AbortSignal.any([
        request.signal,
        ...(source.signal ? [source.signal] : []),
        ...(execution ? [execution.signal] : []),
      ]);
      const assertCurrent = () => {
        source.assertCurrent();
        execution?.assertCurrent();
        modelSignal.throwIfAborted();
      };
      const root =
        getPluginRegistryResourceOwner(registry) === getPluginRegistryState()?.activeRegistry;
      const lifetime = root
        ? undefined
        : capturePluginRegistryLifecycleSignal(
            registry,
            capturePluginRegistryLifecycleEpoch(registry),
            { scopedRuntime: true },
          );
      const isCurrent = root
        ? undefined
        : capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime: true });
      if (!root && (!lifetime || !isCurrent?.())) {
        throw new Error("Decision consumer authority closed.");
      }
      const signal = lifetime ? AbortSignal.any([modelSignal, lifetime]) : modelSignal;
      assertCurrent();
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return entry.host.unavailable("deadline");
      }
      let preparedBilling: ModelDecisionCapabilities["billing"];
      const outcome = await entry.host.evaluateV2(
        request.batch,
        { ...request, agentId, signal, timeoutMs: remaining },
        normalizedSelection.model,
        config,
        registry,
        consumerId,
        selected,
        (billing) => {
          preparedBilling = billing;
        },
      );
      signal.throwIfAborted();
      assertCurrent();
      if (isCurrent && !isCurrent()) {
        throw new Error("Decision consumer authority closed.");
      }
      if (outcome.status === "ok") {
        if (performance.now() >= deadline) {
          return entry.host.unavailable("deadline");
        }
        const usage = outcome.result.usage;
        const finalized = finalizePluginModelUsage({
          cfg: config,
          hostPluginId: consumerId,
          estimate: "none",
          // Native unit counters are not tokens; route invalidation leaves no pricing authority.
          declaredCost:
            preparedBilling?.unit === "tokens" && !usage?.units && preparedBilling.usdPerMillion
              ? { ...preparedBilling.usdPerMillion, cacheRead: 0, cacheWrite: 0 }
              : undefined,
          target: {
            provider: normalizedSelection.provider,
            model: normalizedSelection.model,
            agentId,
            ...(authority?.sessionKey ? { sessionKey: authority.sessionKey } : {}),
          },
          rawUsage: usage
            ? {
                ...(usage.inputTokens !== undefined ? { input: usage.inputTokens } : {}),
                ...(usage.outputTokens !== undefined ? { output: usage.outputTokens } : {}),
                ...(usage.costUsd !== undefined ? { cost: usage.costUsd } : {}),
              }
            : undefined,
        });
        // V1 cannot represent USD: record the host estimate without changing whether
        // the original provider result can be narrowed losslessly to that SDK contract.
        if (
          resultVersion === 2 &&
          finalized.costUsd !== undefined &&
          usage?.costUsd === undefined
        ) {
          return {
            ...outcome,
            result: { ...outcome.result, usage: { ...usage, costUsd: finalized.costUsd } },
          };
        }
      }
      return outcome;
    },
  )(params);
}

/** Abort before dependent consumers drain. Services subsequently join actual physical settlement. */
export function prepareDecisionProviderReload(
  registry: PluginRegistry,
  changedPluginIds: ReadonlySet<string>,
) {
  const paused: ReturnType<DecisionProviderHost["pauseForReload"]>[] = [];
  for (const entry of registry.decisionProviders) {
    if (changedPluginIds.has(entry.pluginId)) {
      paused.push(entry.host.pauseForReload(changedPluginIds));
    } else {
      for (const pluginId of changedPluginIds) {
        entry.host.cancelConsumer(pluginId);
      }
    }
  }
  return {
    async rollback(signal: AbortSignal) {
      // Timeout only observes settlement: no detached continuation may reopen admission.
      await withPluginHostCleanupTimeout("decision reload rollback", () =>
        Promise.all(paused.map((pause) => pause.settled)),
      );
      signal.throwIfAborted();
      for (const pause of paused) {
        pause.assertResumable();
      }
      for (const pause of paused) {
        pause.resume();
      }
    },
  };
}

export function inspectDecisionProviders(
  config: OpenClawConfig,
  registry = getPluginRegistryForContext(),
) {
  return registry?.decisionProviders.map((entry) => entry.host.inspect(config)) ?? [];
}
