import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
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
  const locksPersistedHarness =
    pinnedHarnessId !== undefined && pinnedHarnessId === sessionRuntimeOverride;
  const selectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, { config });
  const pinnedCliRuntime =
    !locksPersistedHarness &&
    sessionRuntimeOverride &&
    isCliProvider(sessionRuntimeOverride, config)
      ? sessionRuntimeOverride
      : undefined;
  const cliExecutionProvider =
    pinnedCliRuntime ??
    (sessionRuntimeOverride
      ? provider
      : (resolveCliRuntimeExecutionProvider({
          provider,
          cfg: config,
          agentId: candidateRun.agentId,
          modelId: model,
          authProfileId: selectedAuthProfile.authProfileId,
        }) ?? provider));
  return {
    candidateRun,
    sessionRuntimeOverride,
    cliExecutionProvider,
    useCliExecution:
      pinnedCliRuntime !== undefined ||
      (!sessionRuntimeOverride && isCliProvider(cliExecutionProvider, config)),
  };
}
