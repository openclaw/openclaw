import { bindOperatorModelExecution } from "../agents/admitted-run-context.js";
import { resolveDecisionModelSetting } from "../agents/decision-model-setting.js";
import { normalizeModelRef } from "../agents/model-ref-shared.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureAmbientGatewayOperatorAuthority } from "../gateway/operator-invocation-authority.js";
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
import {
  assertAllowedCompletionModel,
  resolveAllowAgentIdOverride,
  resolvePluginLlmPolicy,
  resolveRequestedRuntimeAgentId,
} from "../plugins/runtime/runtime-model-policy.js";
import { modelKey } from "../shared/model-key.js";
import type { DecisionProviderHost } from "./provider-host.js";
import type { DecisionBatch, DecisionOutcome, DecisionRuntimeV1 } from "./types.js";
import { DecisionContractError, validateDecisionBatch } from "./validation.js";

type Options = Parameters<DecisionRuntimeV1["evaluate"]>[1];

/** Core calls carry their owner's abort signal; plugin callers additionally bind their exact instance. */
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
  if (!validateDecisionBatch(batch)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  // Only the registry wrapper supplies consumer identity. Request options cannot
  // opt out of plugin policy or choose another plugin's policy entry.
  const pluginPolicy = resolvePluginLlmPolicy(config, consumerId);
  const agentId = consumerId
    ? resolveRequestedRuntimeAgentId({
        agentId: options.agentId,
        allowAgentIdOverride: resolveAllowAgentIdOverride({ pluginPolicy }),
      })
    : options.agentId;
  // Omission intentionally selects the global decision role, not the ambient agent.
  const selected = resolveDecisionModelSetting(config, agentId);
  if (!selected) {
    return { status: "unavailable", reason: "disabled" };
  }
  if (config.plugins?.enabled === false) {
    return { status: "unavailable", reason: "disabled" };
  }
  const entry = registry?.decisionProviders.find(
    (candidate) => candidate.host.provider.id === selected.provider,
  );
  if (!entry || !registry) {
    return { status: "unavailable", reason: "not-configured" };
  }
  if (config.plugins?.entries?.[entry.pluginId]?.enabled === false) {
    return entry.host.unavailable("disabled");
  }
  let capturedOperator: ReturnType<typeof captureAmbientGatewayOperatorAuthority> | undefined;
  let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
  try {
    capturedOperator = captureAmbientGatewayOperatorAuthority({
      missingBindingError: () =>
        new Error("Decision evaluation requires its current Gateway binding."),
    });
    const normalizedSelection = normalizeModelRef(selected.provider, selected.model, {
      allowPluginNormalization: false,
      manifestPlugins: getProcessGatewayPluginMetadataSnapshot() ?? [],
    });
    modelExecution = bindOperatorModelExecution(capturedOperator.authority, normalizedSelection);
    // A configured role is not a caller model override. Only all-completion
    // restrictions apply; the operator guard remains an independent boundary.
    assertAllowedCompletionModel({
      resolvedModelRef: modelKey(normalizedSelection.provider, normalizedSelection.model),
      pluginPolicyId: consumerId,
      pluginPolicy,
    });
    const modelSignal = modelExecution
      ? AbortSignal.any([options.signal, modelExecution.signal])
      : options.signal;
    const assertCurrent = () => {
      capturedOperator?.assertInvocationCurrent?.();
      modelExecution?.assertCurrent();
      modelSignal.throwIfAborted();
    };
    assertCurrent();
    // Root callers carry their own work signal: provider replacement may still allow fallback.
    // Prepared views additionally lose consumer authority when their finite view is released.
    if (getPluginRegistryResourceOwner(registry) === getPluginRegistryState()?.activeRegistry) {
      const result = await entry.host.evaluate(
        batch,
        { ...options, agentId, signal: modelSignal },
        selected.model,
        config,
        registry,
        consumerId,
      );
      assertCurrent();
      return result;
    }
    const authority = capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime: true });
    const lifetime = capturePluginRegistryLifecycleSignal(
      registry,
      capturePluginRegistryLifecycleEpoch(registry),
      { scopedRuntime: true },
    );
    if (!authority?.() || !lifetime) {
      throw new Error("Decision consumer authority closed.");
    }
    const signal = AbortSignal.any([modelSignal, lifetime]);
    const result = await entry.host.evaluate(
      batch,
      { ...options, agentId, signal },
      selected.model,
      config,
      registry,
      consumerId,
    );
    signal.throwIfAborted();
    assertCurrent();
    if (!authority()) {
      throw new Error("Decision consumer authority closed.");
    }
    return result;
  } finally {
    modelExecution?.release();
    capturedOperator?.release?.();
  }
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
