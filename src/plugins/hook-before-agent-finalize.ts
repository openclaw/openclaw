import { concatOptionalTextSegments } from "../shared/text/join-segments.js";
import type {
  BeforeAgentFinalizeResultWithRetryCandidates,
  BeforeAgentFinalizeRetry,
} from "./hook-runner-types.js";
import type { PluginHookBeforeAgentFinalizeResult } from "./hook-types.js";

export function mergeBeforeAgentFinalize(
  acc: BeforeAgentFinalizeResultWithRetryCandidates | undefined,
  next: PluginHookBeforeAgentFinalizeResult,
): BeforeAgentFinalizeResultWithRetryCandidates {
  const normalizeRetry = (
    retry: PluginHookBeforeAgentFinalizeResult["retry"] | undefined,
  ): BeforeAgentFinalizeRetry | undefined => {
    const instruction = typeof retry?.instruction === "string" ? retry.instruction.trim() : "";
    if (!instruction) {
      return undefined;
    }
    return {
      ...retry,
      instruction,
    };
  };
  if (acc?.action === "finalize") {
    return acc;
  }
  if (next.action === "finalize") {
    return { action: "finalize", reason: next.reason };
  }
  if (acc?.action === "revise" && next.action === "revise") {
    const nextRetry = normalizeRetry(next.retry);
    const retryCandidates = [
      ...(acc.retryCandidates ?? (acc.retry ? [acc.retry] : [])),
      ...(nextRetry ? [nextRetry] : []),
    ];
    const retry = retryCandidates[0];
    const result: BeforeAgentFinalizeResultWithRetryCandidates = {
      action: "revise",
      reason: concatOptionalTextSegments({ left: acc.reason, right: next.reason }),
      ...(retry ? { retry } : {}),
    };
    if (retryCandidates.length > 1) {
      Object.defineProperty(result, "retryCandidates", {
        configurable: true,
        enumerable: false,
        value: retryCandidates,
      });
    }
    return result;
  }
  if (acc?.action === "revise") {
    return acc;
  }
  if (next.action === "revise") {
    const retry = normalizeRetry(next.retry);
    return {
      action: "revise",
      reason: next.reason,
      ...(retry ? { retry } : {}),
    };
  }
  return next.action === "continue" ? { action: "continue", reason: next.reason } : (acc ?? next);
}
