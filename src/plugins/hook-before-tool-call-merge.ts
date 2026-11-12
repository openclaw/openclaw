import { cloneHookIsolationValue } from "./hook-isolation.js";
import type { ModifyingHookPolicy } from "./hook-runner-types.js";

type BeforeToolCallMergeResults = NonNullable<
  ModifyingHookPolicy<"before_tool_call">["mergeResults"]
>;

/**
 * before_tool_call result chain. A block short-circuits the whole result;
 * params freeze at the first requireApproval snapshot so later handlers can
 * block but not change what the operator reviewed; requestMeta shallow-merges
 * per key for the entire chain (later handlers win per key) because the
 * operator reviews params and approval text, never this transport lane.
 */
export const mergeBeforeToolCallResults: BeforeToolCallMergeResults = (acc, next, reg) => {
  if (acc?.block === true) {
    return acc;
  }
  const approvalAlreadyRequested = acc?.requireApproval !== undefined;
  let params = next.params ?? acc?.params;
  if (approvalAlreadyRequested) {
    params = acc?.params;
  } else if (next.requireApproval && params !== undefined) {
    // Approval covers one detached snapshot. Later hooks may still
    // block, but they cannot change what the operator reviewed.
    params = cloneHookIsolationValue("before_tool_call", params);
  }
  const requestMeta = acc?.requestMeta
    ? next.requestMeta
      ? { ...acc.requestMeta, ...next.requestMeta }
      : acc.requestMeta
    : next.requestMeta;
  return {
    params,
    requestMeta,
    // acc.block === true returned above, so only this result can stick.
    block: next.block === true ? true : undefined,
    blockReason: next.blockReason ?? acc?.blockReason,
    requireApproval:
      acc?.requireApproval ??
      (next.requireApproval ? { ...next.requireApproval, pluginId: reg.pluginId } : undefined),
  };
};
