import { resolveRunEntryCliRuntime } from "../../agents/embedded-agent-runner/run-entry-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { resolveFallbackCandidateRun, resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import type { FollowupRun } from "./queue.js";

/** Selects the execution boundary shared by reply admission and fallback candidates. */
export function resolveReplyCandidateRuntime(params: {
  run: FollowupRun["run"];
  config: OpenClawConfig;
  provider: string;
  model: string;
  sessionEntry?: Pick<
    SessionEntry,
    "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked" | "pluginOwnerId"
  >;
  sessionRuntimeOverride?: string;
}) {
  const { config, provider, model, sessionRuntimeOverride } = params;
  const candidateRun = resolveFallbackCandidateRun(params.run, provider, model);
  const pinnedHarnessId = resolveSessionPinnedHarnessId(params.sessionEntry);
  const selectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, { config });
  return {
    candidateRun,
    sessionRuntimeOverride,
    ...resolveRunEntryCliRuntime({
      config,
      provider,
      model,
      agentId: candidateRun.agentId,
      authProfileId: selectedAuthProfile.authProfileId,
      sessionRuntimeOverride,
      pinnedHarnessId,
    }),
  };
}
