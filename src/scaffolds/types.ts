import type { OpenClawConfig } from "../config/types.js";

export type EmbeddedRunPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  audioAsVoice?: boolean;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};

export type ReasoningScaffoldsPhase0Config = {
  /** Gate for Phase 0 scaffolds (no-op placeholder in this phase). */
  enabled?: boolean;
  /** Reserved for forward compatibility; must be 0 when set. */
  phase?: 0;
};

export type ScaffoldsConfig = {
  reasoning?: ReasoningScaffoldsPhase0Config;
};

export type OpenClawConfigWithScaffolds = OpenClawConfig & {
  scaffolds?: ScaffoldsConfig;
};
