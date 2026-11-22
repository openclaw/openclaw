import type { Model } from "../llm/types.js";

/** Cache identity a live attempt lends a fork of its session. */
export type SessionForkContextSnapshot = {
  model: Model;
  /** The attempt's provider prompt-cache key, so the fork reads the parent's cached prefix. */
  promptCacheKey?: string;
};
