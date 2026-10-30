import {
  assertOperatorModelAllowed,
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { createLlmOperatorAuthorizationError } from "./runtime-llm-error.js";
import type { LlmCompleteCaller, LlmCompleteParams, LlmCompleteResult } from "./types-core.js";

type CompletionOperatorSource = {
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
      const signal = operatorAuthority?.signal
        ? params.signal
          ? AbortSignal.any([params.signal, operatorAuthority.signal])
          : operatorAuthority.signal
        : params.signal;
      // Operator currency only: the caller's own abort settles through the provider result.
      const assertCurrent = () => {
        withOperatorAuthorization(() => {
          capturedOperator.assertInvocationCurrent?.();
          operatorAuthority?.assertCurrent();
        });
      };
      assertCurrent();
      return await complete(params, {
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
