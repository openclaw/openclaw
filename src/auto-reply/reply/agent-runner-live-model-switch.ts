import type { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

export function applyLiveModelSwitchToRun(
  run: FollowupRun["run"],
  err: LiveSessionModelSwitchError,
): Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked" | "pluginOwnerId"
> {
  run.provider = err.provider;
  run.model = err.model;
  run.authProfileId = err.authProfileId;
  run.authProfileIdSource = err.authProfileId ? err.authProfileIdSource : undefined;
  run.autoFallbackPrimaryProbe = undefined;
  // Keep runtime paired with the error's model/auth winner even if the
  // active in-memory session snapshot lags the persisted directive write.
  return { agentRuntimeOverride: err.agentRuntimeOverride };
}
