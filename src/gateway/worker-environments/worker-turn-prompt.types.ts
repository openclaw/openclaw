import type { FastMode } from "../../shared/fast-mode.js";

export type WorkerTurnPromptCacheContext = Readonly<{
  boundaryCount: number;
  promptCacheKey?: string;
  fastMode?: FastMode;
  fastModeStartedAtMs?: number;
  fastModeAutoOnSeconds?: number;
}>;
