import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Select mediated execution for an implicit Codex review without rewriting model config. */
export function resolveSkillCollectionReviewRuntimeOverride(params: {
  config: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
  sessionEntry?: SessionEntry;
}): string | undefined {
  const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
    cfg: params.config,
    provider: params.provider,
    entry: params.sessionEntry,
  });
  if (sessionRuntime) {
    return sessionRuntime;
  }
  const policy = resolveAgentHarnessPolicy(params);
  return policy.runtime === "codex" && policy.runtimeSource === "implicit" ? "openclaw" : undefined;
}
