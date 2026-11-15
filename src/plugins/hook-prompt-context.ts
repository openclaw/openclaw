import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { concatOptionalTextSegments } from "../shared/text/join-segments.js";
import type { HookRunnerOptions } from "./hook-runner-types.js";
import type {
  PluginAgentTurnPrepareResult,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
} from "./hook-types.js";

const SYSTEM_CONTEXT_TRUNCATION_MARKER =
  "\n[Plugin system context truncated to fit the model budget.]";

function boundSystemContext(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined || estimateStringChars(value) <= maxChars) {
    return value;
  }
  const headBudget = Math.max(0, maxChars - SYSTEM_CONTEXT_TRUNCATION_MARKER.length);
  let low = 0;
  let high = Math.min(value.length, headBudget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateStringChars(truncateUtf16Safe(value, mid)) <= headBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return (
    truncateUtf16Safe(value, low) + truncateUtf16Safe(SYSTEM_CONTEXT_TRUNCATION_MARKER, maxChars)
  );
}

export function createPluginSystemContextLimiter(logger: HookRunnerOptions["logger"]) {
  // Bounded process-local diagnostics; an evicted session may warn again.
  const systemContextWarnings = createDedupeCache({ ttlMs: 0, maxSize: 4_096 });
  return (
    next: PluginHookBeforePromptBuildResult,
    pluginId: string,
    ctx: PluginHookAgentContext,
  ) => {
    const maxChars = Math.floor(
      (asPositiveFiniteNumber(ctx.contextTokenBudget) ?? DEFAULT_CONTEXT_TOKENS) *
        CHARS_PER_TOKEN_ESTIMATE *
        0.25,
    );
    const prependSystemContext = boundSystemContext(next.prependSystemContext, maxChars);
    const appendSystemContext = boundSystemContext(next.appendSystemContext, maxChars);
    if (
      (prependSystemContext !== next.prependSystemContext ||
        appendSystemContext !== next.appendSystemContext) &&
      !systemContextWarnings.check(
        ctx.sessionId || ctx.sessionKey
          ? JSON.stringify([ctx.agentId, ctx.sessionKey, ctx.sessionId, pluginId])
          : undefined,
      )
    ) {
      logger?.warn?.(
        `[hooks] before_prompt_build: plugin ${pluginId} system context truncated ` +
          `(prepend: ${next.prependSystemContext?.length ?? 0} -> ${prependSystemContext?.length ?? 0} chars; ` +
          `append: ${next.appendSystemContext?.length ?? 0} -> ${appendSystemContext?.length ?? 0} chars)`,
      );
    }
    return { prependSystemContext, appendSystemContext };
  };
}

export const mergeAgentTurnPrepare = (
  acc: PluginAgentTurnPrepareResult | undefined,
  next: PluginAgentTurnPrepareResult,
): PluginAgentTurnPrepareResult => ({
  prependContext: concatOptionalTextSegments({
    left: acc?.prependContext,
    right: next.prependContext,
  }),
  appendContext: concatOptionalTextSegments({
    left: acc?.appendContext,
    right: next.appendContext,
  }),
});
