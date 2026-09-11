import type { OpenClawConfig } from "../../config/config.js";

export type WorktreeGitIsolation = {
  config: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  /** Persisted provenance requires this boundary even if current session policy changed. */
  required?: boolean;
};
