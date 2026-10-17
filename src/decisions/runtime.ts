import { bindOperatorModelExecution } from "../agents/admitted-run-context.js";
import { resolveDecisionModelSetting } from "../agents/decision-model-setting.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
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
  resolvePluginLlmPolicy,
} from "../plugins/runtime/runtime-model-policy.js";
import { modelKey } from "../shared/model-key.js";
import { logDecisionEvaluation } from "./diagnostics.js";
import type { DecisionProviderHost, PreparedDecisionBilling } from "./provider-host.js";
import type { DecisionBatchV2, DecisionEvaluateOptionsV2, DecisionOutcomeV2 } from "./types-v2.js";
import type { DecisionBatch, DecisionOutcome, DecisionRuntimeV1 } from "./types.js";
import { validateDecisionBatchV2 } from "./validation-v2.js";
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

export function evaluateDecisionV2(
  batch: DecisionBatchV2,
  options: DecisionEvaluateOptionsV2,
): Promise<DecisionOutcomeV2> {
  return evaluateDecisionV2InRegistry(
    batch,
    options,
    getPluginRegistryForContext(),
    getRuntimeConfig(),
  );
}

export function evaluateDecisionInRegistry(
  batch: DecisionBatch,
  options: Options,
  registry: PluginRegistry | null | undefined,
  config: OpenClawConfig,
  consumerId?: string,
  isAdmissible?: () => boolean,
  canDispatch?: () => boolean,
): Promise<DecisionOutcome> {
  return evaluateVersion(
    batch,
    options,
    registry,
    config,
    1,
    consumerId,
    isAdmissible,
    canDispatch,
  ) as Promise<DecisionOutcome>; // SAFETY: Version 1 dispatch validates a V1 batch and returns the paired V1 outcome.
}

export function evaluateDecisionV2InRegistry(
  batch: DecisionBatchV2,
  options: DecisionEvaluateOptionsV2,
  registry: PluginRegistry | null | undefined,
  config: OpenClawConfig,
  consumerId?: string,
  isAdmissible?: () => boolean,
  canDispatch?: () => boolean,
  onPreparedBilling?: (facts: PreparedDecisionBilling) => void,
): Promise<DecisionOutcomeV2> {
  return evaluateVersion(
    batch,
    options,
    registry,
    config,
    2,
    consumerId,
    isAdmissible,
    canDispatch,
    onPreparedBilling,
  ) as Promise<DecisionOutcomeV2>; // SAFETY: Version 2 dispatch validates a V2 batch and returns the paired V2 outcome.
}

async function evaluateVersion(
  batch: DecisionBatch | DecisionBatchV2,
  inputOptions: DecisionEvaluateOptionsV2,
  registry: PluginRegistry | null | undefined,
  config: OpenClawConfig,
  version: 1 | 2,
  consumerId?: string,
  isAdmissible?: () => boolean,
  canDispatch?: () => boolean,
  onPreparedBilling?: (facts: PreparedDecisionBilling) => void,
): Promise<DecisionOutcome | DecisionOutcomeV2> {
  const options = { ...inputOptions };
  if (
    !inputOptions ||
    (options.agentId !== undefined &&
      (typeof options.agentId !== "string" || !options.agentId.trim())) ||
    typeof options.purpose !== "string" ||
    !options.purpose ||
    options.purpose.length > 128 ||
    (options.priority !== undefined &&
      options.priority !== "requested" &&
      options.priority !== "optional") ||
    typeof options.rubricVersion !== "string" ||
    !options.rubricVersion ||
    options.rubricVersion.length > 128 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !(options.signal instanceof AbortSignal) ||
    (options.reasoning !== undefined && !["auto", "off", "on"].includes(options.reasoning))
  ) {
    throw new DecisionContractError();
  }
  options.signal.throwIfAborted();
  const started = performance.now();
  const skipped = (
    outcome: DecisionOutcome | DecisionOutcomeV2,
  ): DecisionOutcome | DecisionOutcomeV2 => {
    logDecisionEvaluation({ options, facts: { dispatched: false }, started, outcome });
    return outcome;
  };
  if (!(version === 1 ? validateDecisionBatch(batch) : validateDecisionBatchV2(batch))) {
    return skipped({ status: "unavailable", reason: "unsupported-input" });
  }
  // Registration supplies consumer identity; request fields cannot select another plugin's policy.
  const pluginPolicy = resolvePluginLlmPolicy(config, consumerId);
  // The public Decision contract takes the operation owner explicitly. This runtime
  // is consumer-bound, not agent-bound; LLM override policy would reject owner calls.
  // Omission still selects the global role.
  const selected = resolveDecisionModelSetting(config, options.agentId);
  if (!selected) {
    return skipped({ status: "unavailable", reason: "disabled" });
  }
  if (config.plugins?.enabled === false) {
    return skipped({ status: "unavailable", reason: "disabled" });
  }
  const entry = registry?.decisionProviders.find(
    (candidate) => candidate.host.provider.id === selected.provider,
  );
  if (!entry || !registry) {
    return skipped({ status: "unavailable", reason: "not-configured" });
  }
  if (config.plugins?.entries?.[entry.pluginId]?.enabled === false) {
    return skipped(entry.host.unavailable("disabled"));
  }
  let submitted: DecisionBatch | DecisionBatchV2;
  try {
    submitted = structuredClone(batch);
  } catch {
    throw new DecisionContractError();
  }
  // Credential profiles select auth, not a different model policy identity.
  const model = normalizeModelRef(
    selected.provider,
    splitTrailingAuthProfile(selected.model).model,
    {
      allowPluginNormalization: false,
      manifestPlugins: getProcessGatewayPluginMetadataSnapshot() ?? [],
    },
  );
  // Bind the registry lifetime before operator preparation yields.
  const rootCaller =
    getPluginRegistryResourceOwner(registry) === getPluginRegistryState()?.activeRegistry;
  const authority = rootCaller
    ? undefined
    : capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime: true });
  const lifetime = rootCaller
    ? undefined
    : capturePluginRegistryLifecycleSignal(
        registry,
        capturePluginRegistryLifecycleEpoch(registry),
        { scopedRuntime: true },
      );
  let capturedOperator:
    | Awaited<ReturnType<typeof captureAmbientGatewayOperatorAuthority>>
    | undefined;
  let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
  try {
    capturedOperator = await captureAmbientGatewayOperatorAuthority({
      missingBindingError: () =>
        new Error("Decision evaluation requires its current Gateway binding."),
    });
    modelExecution = bindOperatorModelExecution(capturedOperator.authority, model);
    // A configured role is not a caller model override; only all-completion policy applies.
    assertAllowedCompletionModel({
      resolvedModelRef: modelKey(model.provider, model.model),
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
    let signal = modelSignal;
    if (!rootCaller) {
      if (!authority?.() || !lifetime) {
        throw new Error("Decision consumer authority closed.");
      }
      signal = AbortSignal.any([modelSignal, lifetime]);
      signal.throwIfAborted();
    }
    // Admission-only preferences stop new evaluations after preparation. Do not
    // pass them to the provider: admitted work retains independent live guards.
    if ((canDispatch && !canDispatch()) || (isAdmissible && !isAdmissible())) {
      return skipped({ status: "unavailable", reason: "disabled" });
    }
    // Preparation consumes the caller's budget. The host still owns provider
    // cancellation and waits for physical settlement after its deadline.
    const timeoutMs = options.timeoutMs - (performance.now() - started);
    if (timeoutMs <= 0) {
      return skipped(entry.host.unavailable("deadline"));
    }
    const result =
      version === 1
        ? await entry.host.evaluate(
            submitted as DecisionBatch, // SAFETY: V1 validation and structuredClone preserve the admitted V1 shape.
            { ...options, timeoutMs, signal },
            selected.model,
            config,
            registry,
            consumerId,
            isAdmissible,
          )
        : await entry.host.evaluateV2(
            submitted as DecisionBatchV2, // SAFETY: V2 validation and structuredClone preserve the admitted V2 shape.
            { ...options, timeoutMs, signal },
            selected.model,
            config,
            registry,
            consumerId,
            isAdmissible,
            onPreparedBilling,
          );
    if (!rootCaller) {
      signal.throwIfAborted();
    }
    assertCurrent();
    if (!rootCaller && !authority?.()) {
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
