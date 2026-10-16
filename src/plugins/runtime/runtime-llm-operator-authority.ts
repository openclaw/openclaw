import {
  assertOperatorModelAllowed,
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import { readPluginSessionWorkAuthority } from "../../gateway/plugin-session-work-authority.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { createLlmOperatorAuthorizationError } from "./runtime-llm-error.js";
import type { LlmCompleteCaller, LlmCompleteParams, LlmCompleteResult } from "./types-core.js";

type CompletionOperatorSource = {
  agentBinding?: { kind: "foreground" | "recovery"; agentId: string; sessionKey: string };
  operatorAuthority?: AdmittedRunOperatorAuthority;
  signal?: AbortSignal;
  assertCurrent: () => void;
  assertModelAllowed: (model: ModelRef | undefined) => void;
  bindModelExecution: (
    model: ModelRef | undefined,
  ) => ReturnType<typeof bindOperatorModelExecution>;
};

function withOperatorAuthorization<T>(check: () => T): T {
  try {
    return check();
  } catch (cause) {
    throw createLlmOperatorAuthorizationError(cause);
  }
}

/** Keep the original requester through preparation, provider work, and asynchronous cleanup. */
export function bindLlmOperatorAuthority(
  hostCaller: LlmCompleteCaller | undefined,
  complete: (
    params: LlmCompleteParams,
    source: CompletionOperatorSource,
  ) => Promise<LlmCompleteResult>,
): (params: LlmCompleteParams) => Promise<LlmCompleteResult> {
  return (input) => {
    const params = { ...input };
    return runWithAsyncWorkResources(async (onAcquired) => {
      // Only the host-issued context-engine capability identifies bounded system maintenance.
      // A request's caller/purpose fields cannot change its execution authority.
      if (hostCaller?.kind === "context-engine") {
        return await complete(params, {
          signal: params.signal,
          assertCurrent: () => {},
          assertModelAllowed: () => {},
          bindModelExecution: () => undefined,
        });
      }
      // Capture the trusted invocation target per call. Scheduled work deliberately
      // has no foreground tool caller; its live host borrow owns this binding.
      const borrowed = readPluginSessionWorkAuthority();
      const caller = getGatewayToolCallerIdentity();
      const target = borrowed?.target ?? caller;
      const agentBinding = target
        ? {
            kind: borrowed ? ("recovery" as const) : ("foreground" as const),
            agentId: target.agentId,
            sessionKey: target.sessionKey,
          }
        : undefined;
      withOperatorAuthorization(() => {
        borrowed?.assertCurrent();
        if (
          borrowed &&
          caller &&
          (caller.agentId !== borrowed.target.agentId ||
            caller.sessionKey !== borrowed.target.sessionKey)
        ) {
          throw new Error("Plugin LLM completion has conflicting invocation targets.");
        }
      });
      const capturedOperator = await captureAmbientGatewayOperatorAuthority({
        missingBindingError: () =>
          new Error("Plugin model completion requires its current Gateway binding."),
        retainInherited: true,
      }).catch((cause: unknown) => {
        throw createLlmOperatorAuthorizationError(cause);
      });
      const resources = new AsyncDisposableStack();
      if (capturedOperator?.release) {
        resources.defer(capturedOperator.release);
      }
      onAcquired({ release: () => resources.disposeAsync() });
      const operatorAuthority = capturedOperator?.authority;
      const signals = [params.signal, operatorAuthority?.signal, borrowed?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      // Host/source currency: the caller's own abort settles through the provider result.
      const assertCurrent = () => {
        withOperatorAuthorization(() => {
          borrowed?.assertCurrent();
          capturedOperator.assertInvocationCurrent?.();
          operatorAuthority?.assertCurrent();
        });
      };
      assertCurrent();
      return await complete(params, {
        agentBinding,
        operatorAuthority,
        signal,
        assertCurrent,
        assertModelAllowed: (model) =>
          withOperatorAuthorization(() => assertOperatorModelAllowed(operatorAuthority, model)),
        bindModelExecution: (model) => {
          const execution = bindOperatorModelExecution(
            operatorAuthority,
            model,
            createLlmOperatorAuthorizationError,
          );
          if (execution) {
            resources.defer(execution.release);
          }
          return execution;
        },
      });
    });
  };
}
