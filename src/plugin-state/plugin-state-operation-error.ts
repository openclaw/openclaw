import {
  collectErrorGraphCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";

/** Prepared state lost authority before the next external effect began. */
export class PluginStateOperationInvalidatedError extends Error {
  constructor() {
    super("Plugin state operation receipt is no longer current");
    this.name = "PluginStateOperationInvalidatedError";
  }
}

/** Runtime authority ended, independently of storage availability. */
export class PluginStateRuntimeInactiveError extends Error {
  readonly code = "PLUGIN_STATE_RUNTIME_INACTIVE";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Plugin state runtime is no longer active");
    this.name = "PluginStateRuntimeInactiveError";
  }
}

/** Storage wrappers retain the runtime refusal as their cause. */
export function isPluginStateRuntimeInactiveError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause]).some(
    (candidate) => extractErrorCode(candidate) === "PLUGIN_STATE_RUNTIME_INACTIVE",
  );
}
