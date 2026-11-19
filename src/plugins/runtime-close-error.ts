import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Source Gateway owners and compiled SDK claims share cleanup custody and error identity.
export const PluginRuntimeCloseRetainedError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRuntimeCloseRetainedError"),
  () =>
    class RetainedRuntimeError extends Error {
      constructor(cause: unknown) {
        super(
          "Plugin runtime still owns resources; inspect cleanup failures before retrying Gateway close.",
          { cause },
        );
        this.name = "PluginRuntimeCloseRetainedError";
      }
    },
);

export type PluginRuntimeCloseRetainedError = InstanceType<typeof PluginRuntimeCloseRetainedError>;

/** The resource owner finished cleanup and returned callback failures for observation. */
export const PluginRuntimeCloseCompletedError = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRuntimeCloseCompletedError"),
  () => class CompletedRuntimeError extends AggregateError {},
);

export function aggregatePluginRuntimeCloseErrors(
  failures: readonly unknown[],
  message: string,
): AggregateError {
  return failures.length > 0 &&
    failures.every((failure) => failure instanceof PluginRuntimeCloseCompletedError)
    ? new PluginRuntimeCloseCompletedError(failures, message)
    : new AggregateError(failures, message);
}

export function hasRetainedPluginRuntimeCloseError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) => candidate instanceof PluginRuntimeCloseRetainedError,
  );
}
