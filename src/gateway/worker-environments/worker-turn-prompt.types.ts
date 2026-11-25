import type { ProviderStateScope } from "@openclaw/ai/internal/runtime";
import type { FastMode } from "../../shared/fast-mode.js";

export type WorkerTurnPromptCacheContext = Readonly<{
  boundaryCount: number;
  promptCacheKey?: string;
  /** The placed turn's writer scope; the Gateway keeps its provider state for the worker. */
  providerStateScope?: ProviderStateScope;
  fastMode?: FastMode;
  fastModeStartedAtMs?: number;
  fastModeAutoOnSeconds?: number;
}>;
