import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import {
  acquirePublishedPreparedModelRuntime,
  preparedModelRuntimeConfigsMatch,
  type PreparedModelRuntimeLease,
} from "../agents/prepared-model-runtime.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  resolveSystemAgentVerifiedInferenceState,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

/** Explicit admission at the reserved agent boundary; caller authority remains ambient. */
export async function acquireSystemAgentInferenceOwner(params: {
  binding: SystemAgentVerifiedInferenceBinding;
  stage?: "agent-turn" | "planner";
  deps: SystemAgentVerifiedInferenceDeps;
  timeoutMs: number;
  isBindingCurrent: () => boolean;
}): Promise<PreparedModelRuntimeLease & { signal: AbortSignal }> {
  const assertCaller = captureGatewayToolCallerAssertion();
  // Only caller cancellation follows custody into execution. The embedded runner
  // owns preparation/execution timing, approval pauses and compaction grace.
  const executionSignal = AbortSignal.any([
    ...(getGatewayToolCallerIdentity()?.approvalSignals ?? []),
  ]);
  const admission = new AbortController();
  const signal = AbortSignal.any([executionSignal, admission.signal]);
  const timer =
    params.timeoutMs >= MAX_TIMER_TIMEOUT_MS
      ? undefined
      : setTimeout(
          () => admission.abort(new DOMException("Inference admission timed out", "TimeoutError")),
          params.timeoutMs,
        );
  timer?.unref();
  try {
    const assertActive = () => {
      signal.throwIfAborted();
      assertCaller?.();
      if (!params.isBindingCurrent()) {
        throw new SystemAgentInferenceUnavailableError(params.stage ?? "agent-turn");
      }
    };
    assertActive();
    const state = await racePromiseWithAbortSignal(
      resolveSystemAgentVerifiedInferenceState(params.binding, params.deps),
      signal,
    );
    assertActive();
    if (!state) {
      throw new SystemAgentInferenceUnavailableError(params.stage ?? "agent-turn");
    }
    // Publication builds are shared lifecycle work and cannot be cancelled by a reader.
    // The acquisition continuation owns a late lease until the awaiting caller
    // explicitly transfers custody; cancellation has one idempotent cleanup owner.
    let abandoned = false;
    let acquired: PreparedModelRuntimeLease | undefined;
    const releaseAcquired = async () => {
      const lease = acquired;
      acquired = undefined;
      await lease?.[Symbol.asyncDispose]();
    };
    const acquisition = acquirePublishedPreparedModelRuntime({
      config: state.config,
      agentId: state.route.agentId,
      agentDir: state.route.agentDir,
    }).then(async (lease) => {
      acquired = lease;
      if (abandoned || signal.aborted) {
        await releaseAcquired();
        signal.throwIfAborted();
        throw new SystemAgentInferenceUnavailableError(params.stage ?? "agent-turn");
      }
      return lease;
    });
    let lease: PreparedModelRuntimeLease;
    try {
      lease = await racePromiseWithAbortSignal(acquisition, signal);
      acquired = undefined;
    } catch (error) {
      abandoned = true;
      await releaseAcquired();
      throw error;
    }
    try {
      const current = await racePromiseWithAbortSignal(
        resolveSystemAgentVerifiedInferenceState(params.binding, params.deps),
        signal,
      );
      assertActive();
      if (!current || !preparedModelRuntimeConfigsMatch(lease.snapshot.config, current.config)) {
        throw new SystemAgentInferenceUnavailableError(params.stage ?? "agent-turn");
      }
      return { ...lease, signal: executionSignal };
    } catch (error) {
      await lease[Symbol.asyncDispose]();
      throw error;
    }
  } finally {
    // Cancel on failure or successful lease handoff; never leave an execution timer.
    clearTimeout(timer);
  }
}
