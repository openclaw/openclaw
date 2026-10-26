import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import type { DraftSessionCreateSelection } from "./create-params.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";

export function buildSelectedSessionCreateParams(
  place: DraftPlaceState,
  params: DraftSessionCreateSelection,
): SessionCreateParams {
  const draft = {
    ...params,
    deferInitialTurn: place.remotePlacement,
    agentId: place.agentId,
    model: place.modelControl.modelForSubmission(),
    agentRuntime: place.modelControl.agentRuntime,
    contextWindow: place.modelControl.contextWindow,
    thinkingLevel: place.modelControl.thinkingLevel,
    fastMode: place.modelControl.fastMode,
    projectId: place.hostedEnvironment
      ? undefined
      : (place.browser.remoteProject?.projectId ?? place.browser.projectId),
    projectGitUrl: place.hostedEnvironment ? undefined : place.browser.remoteProject?.cloneUrl,
    repository: place.remoteRepository,
    deviceFolder: place.deviceFolder,
    worktree: place.worktree,
    worktreeSource: place.freshWorkspace ? "empty" : undefined,
    baseRef: place.baseRef,
    worktreeName: place.worktreeName,
    cwd: place.hostedEnvironment ? undefined : place.folder,
    workspace: place.workspacePath(),
  };
  const displayName = normalizeOptionalString(draft.displayName);
  const baseRef = normalizeOptionalString(draft.baseRef);
  const worktreeName = normalizeOptionalString(draft.worktreeName);
  const cwd = normalizeOptionalString(draft.cwd);
  const workspace = normalizeOptionalString(draft.workspace);
  const catalogId = normalizeOptionalString(draft.catalogId);
  const category = normalizeOptionalString(draft.category);
  const model = normalizeOptionalString(draft.model);
  const agentRuntime = normalizeOptionalString(draft.agentRuntime);
  const contextWindow = normalizeOptionalString(draft.contextWindow);
  const thinkingLevel = normalizeOptionalString(draft.thinkingLevel);
  const message = draft.deferInitialTurn ? "" : draft.message;
  const titleSource =
    draft.deferInitialTurn && draft.visibility !== "incognito"
      ? truncateUtf16Safe(draft.message.trim(), 1_000)
      : undefined;
  const deviceFolder = draft.deviceFolder;
  const emptyWorkspace = !deviceFolder && draft.worktreeSource === "empty";
  const repository = deviceFolder || emptyWorkspace ? undefined : draft.repository;
  const projectId =
    deviceFolder || emptyWorkspace || repository
      ? undefined
      : normalizeOptionalString(draft.projectId);
  const projectGitUrl =
    !deviceFolder &&
    !emptyWorkspace &&
    !repository &&
    !projectId &&
    (message.trim() || (!draft.deferInitialTurn && draft.attachments?.length))
      ? normalizeOptionalString(draft.projectGitUrl)
      : undefined;
  const customFolder =
    !deviceFolder &&
    !emptyWorkspace &&
    !repository &&
    !projectId &&
    !projectGitUrl &&
    cwd &&
    cwd !== workspace
      ? cwd
      : undefined;
  return {
    agentId: normalizeAgentId(draft.agentId),
    message,
    ...(!draft.deferInitialTurn && draft.mentions?.length
      ? { mentions: draft.mentions.map((mention) => ({ ...mention })) }
      : {}),
    ...(displayName ? { displayName } : {}),
    ...(displayName && draft.displayNameGenerated
      ? { displayNameGenerated: draft.displayNameGenerated }
      : {}),
    ...(titleSource ? { titleSource } : {}),
    ...(draft.visibility === "incognito" ? { incognito: true } : {}),
    ...(draft.visibility === "draft" ? { visibility: "draft" } : {}),
    ...(!draft.deferInitialTurn && draft.attachments?.length
      ? { attachments: draft.attachments }
      : {}),
    ...(catalogId ? { catalogId } : {}),
    ...(category ? { category } : {}),
    ...(!catalogId && model ? { model } : {}),
    ...(!catalogId && model && agentRuntime ? { agentRuntime } : {}),
    ...(!catalogId && contextWindow ? { contextWindow } : {}),
    ...(!catalogId && thinkingLevel ? { thinkingLevel } : {}),
    ...(!catalogId && draft.fastMode !== undefined ? { fastMode: draft.fastMode } : {}),
    ...(draft.toolOverrides ? { toolOverrides: draft.toolOverrides } : {}),
    ...(draft.permissionMode ? { permissionMode: draft.permissionMode } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectGitUrl ? { projectGitUrl } : {}),
    ...(repository ? { repository: { ...repository } } : {}),
    ...(deviceFolder ? { deviceFolder: { ...deviceFolder, path: deviceFolder.path.trim() } } : {}),
    ...(customFolder ? { cwd: customFolder } : {}),
    ...(emptyWorkspace ? { worktree: true, worktreeSource: "empty" as const } : {}),
    ...(draft.worktree && !deviceFolder && !repository && !emptyWorkspace
      ? {
          worktree: true,
          // Passing the base explicitly also skips the create-time origin fetch.
          ...(baseRef ? { worktreeBaseRef: baseRef } : {}),
          ...(worktreeName ? { worktreeName } : {}),
        }
      : {}),
  };
}
