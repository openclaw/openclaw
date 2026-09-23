import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import {
  buildDraftSessionCreateParams,
  type DraftSessionCreateSelection,
} from "./create-params.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";

export function buildSelectedSessionCreateParams(
  place: DraftPlaceState,
  params: DraftSessionCreateSelection,
): SessionCreateParams {
  return buildDraftSessionCreateParams({
    ...params,
    deferInitialTurn: place.remotePlacement,
    agentId: place.agentId,
    model: place.modelControl.modelForSubmission(),
    agentRuntime: place.modelControl.agentRuntime,
    contextWindow: place.modelControl.contextWindow,
    thinkingLevel: place.modelControl.thinkingLevel,
    fastMode: place.modelControl.fastMode,
    projectId: place.browser.remoteProject?.projectId ?? place.browser.projectId,
    projectGitUrl: place.browser.remoteProject?.cloneUrl,
    repository: place.remoteRepository,
    worktree: place.worktree,
    worktreeSource: place.freshWorkspace ? "empty" : undefined,
    baseRef: place.baseRef,
    worktreeName: place.worktreeName,
    cwd: place.folder,
    workspace: place.workspacePath(),
  });
}
