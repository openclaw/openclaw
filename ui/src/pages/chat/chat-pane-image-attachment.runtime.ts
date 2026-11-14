import { BROWSER_IMAGE_MIME_TYPES } from "../../../../src/shared/browser-image-mime-types.js";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { readLightboxOriginalBlob } from "../../components/image-lightbox-files.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { readChatPaneRouteMutationAccess } from "./chat-pane-session-controls.ts";
import type { ChatPaneStateOwner } from "./chat-pane-state-owner.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { appendChatAttachmentFiles } from "./components/chat-attachments.ts";

/** The pane retains destination authority; the lightbox supplies current selection intent. */
export default async function useLightboxImage(
  pane: Pick<
    ChatPaneStateOwner,
    | "state"
    | "active"
    | "presented"
    | "connectionGeneration"
    | "context"
    | "chatState"
    | "awaitDomCommit"
    | "sessionParticipationTracker"
  > & { focusComposerInput(): boolean },
  state: ChatPageHost,
  sessionKey: string,
  version: number,
  connectionGeneration: number,
  item: ImageLightboxItem,
  isSelected: () => boolean,
): Promise<void> {
  const ownsDestination = () =>
    pane.state === state &&
    pane.active &&
    pane.presented &&
    state.connected &&
    pane.connectionGeneration === connectionGeneration &&
    state.sessionKey === sessionKey &&
    state.imageLightboxRequestVersion === version &&
    isSelected();
  const canCompose = () => {
    const snapshot = pane.context.gateway.snapshot;
    const session = selectedChatSessionRow(state);
    if (
      pane.sessionParticipationTracker.resolve({
        catalog: false,
        listLoading: state.sessionsLoading,
        sessionKey: `${resolveChatAgentId(state) ?? ""}\0${state.sessionKey}`,
        session,
      })
    ) {
      return false;
    }
    return (
      hasOperatorWriteAccess(snapshot.hello?.auth ?? null) ||
      readChatPaneRouteMutationAccess(snapshot, state, session).composeScope.allowed
    );
  };
  if (!ownsDestination() || !canCompose()) {
    return;
  }
  const blob = await readLightboxOriginalBlob(item.originalSrc || item.src, item.readOriginalBlob);
  // The source read can outlive navigation or a permission update. Admit only
  // into the still-selected composer's normal file pipeline, never a new session.
  if (!ownsDestination()) {
    return;
  }
  if (!canCompose()) {
    return;
  }
  const mimeType = blob.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!BROWSER_IMAGE_MIME_TYPES.has(mimeType) && mimeType !== "image/svg+xml") {
    throw new Error("Unsupported image");
  }
  const file = new File([blob], item.title, {
    type: mimeType,
  });
  if (!appendChatAttachmentFiles([file], pane.chatState.attachmentInputProps(state))) {
    return;
  }
  state.handleCloseImage();
  await pane.awaitDomCommit();
  if (pane.state === state && state.sessionKey === sessionKey && pane.presented) {
    pane.focusComposerInput();
  }
}
