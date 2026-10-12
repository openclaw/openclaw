import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { GetReplyOptions, PreparedAgentRunStart } from "./get-reply-options.types.js";

type RunStartOptions = Pick<GetReplyOptions, "onAgentRunStart" | "onPreparedAgentRunStart">;

/** Keep completion acknowledgment synchronous after transcript preparation has finished. */
export function notifyPreparedAgentRunStart(
  options: RunStartOptions | undefined,
  start: PreparedAgentRunStart,
): unknown {
  if (options?.onPreparedAgentRunStart) {
    return options.onPreparedAgentRunStart(start);
  }
  if (options?.onAgentRunStart) {
    warnLegacyAgentRunStart();
    return options.onAgentRunStart(
      start.runId,
      start.executionIdentityToken,
      start.options,
      start.transcriptStart,
    );
  }
}

export function warnLegacyAgentRunStart(): void {
  warnPluginSdkDeprecation({
    family: "reply-run-start",
    method: "onAgentRunStart",
    replacement: "onPreparedAgentRunStart",
    code: "DEP_SESSION_PERSISTENCE",
  });
}

/** Observe either public callback contract without discarding completion ownership. */
export function observeAgentRunStart(
  options: RunStartOptions | undefined,
  observe: (start: Pick<PreparedAgentRunStart, "runId" | "executionIdentityToken">) => void,
): Required<RunStartOptions> {
  return {
    onPreparedAgentRunStart: (start) => {
      observe(start);
      return notifyPreparedAgentRunStart(options, start);
    },
    onAgentRunStart: (...args) => {
      observe({ runId: args[0], executionIdentityToken: args[1] });
      if (options?.onAgentRunStart) {
        warnLegacyAgentRunStart();
        return options.onAgentRunStart(...args);
      }
    },
  };
}
