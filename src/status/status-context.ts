import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  resolveContextTokensForModelFromCache,
  type ContextTokenResolutionParams,
} from "../agents/context-resolution.js";
import { resolveContextTokensForModel } from "../agents/context.js";

export function resolveStatusContextTokens(
  params: ContextTokenResolutionParams,
): number | undefined {
  const hasPublishedLimit =
    asPositiveFiniteNumber(params.modelContextTokens) !== undefined ||
    asPositiveFiniteNumber(params.modelContextWindow) !== undefined;
  if (params.provider?.trim() && params.model?.trim() && hasPublishedLimit) {
    // Status already has provider/model-bound metadata. Keep configured limits,
    // but do not clamp these facts to an older process-wide cache generation.
    // Execution and compaction continue to use the shared cached resolver.
    return resolveContextTokensForModelFromCache(
      params,
      () => undefined,
      () => undefined,
    );
  }
  return resolveContextTokensForModel(params);
}
