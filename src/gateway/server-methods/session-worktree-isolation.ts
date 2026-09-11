import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Reconstruct containment from durable provenance, independent of current policy. */
export function resolvePersistedWorktreeGitIsolation(params: {
  sandboxGit?: true;
  config: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}) {
  return params.sandboxGit
    ? {
        config: params.config,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        required: true as const,
      }
    : undefined;
}
