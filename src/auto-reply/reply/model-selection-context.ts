import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveContextTokens(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  modelContextWindow?: number;
  modelContextWindowSource?: "synthetic";
  modelContextTokens?: number;
  nativeRuntime?: string;
}): number {
  return (
    resolveContextTokensForModel({
      ...params,
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS
  );
}
