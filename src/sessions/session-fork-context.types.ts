import type { Model } from "../llm/types.js";

/** An attempt's last post-hook provider request body; session forks replay it. */
export type PreparedProviderRequest = { model: Model; body: Record<string, unknown> };

/** What a live attempt lends a session fork of its session, so the fork sends its request. */
export type SessionForkContextSnapshot = {
  model: Model;
  /** The attempt's provider prompt-cache key, so the fork reads the parent's cached prefix. */
  promptCacheKey?: string;
  /** The attempt's last provider request, which the fork replays ahead of its own suffix. */
  preparedRequest?: PreparedProviderRequest;
};
