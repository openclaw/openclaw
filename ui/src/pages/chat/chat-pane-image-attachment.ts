import { BROWSER_IMAGE_MIME_TYPES } from "../../../../src/shared/browser-image-mime-types.js";
import { fetchControlUiResource } from "../../app/browser-http.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import type { ImageLightboxProps } from "../../components/image-lightbox.types.ts";
import { imageFileName } from "../../lib/image-download.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import { readChatPaneRouteMutationAccess } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view.tsx";
import { appendChatAttachmentFiles } from "./components/chat-attachments.ts";

/** The pane retains destination authority; the lightbox supplies current selection intent. */
export function createLightboxComposerAction(
  pane: Pick<
    ChatPaneRuntime,
    | "state"
    | "active"
    | "presented"
    | "connectionGeneration"
    | "context"
    | "chatState"
    | "awaitDomCommit"
    | "focusComposerInput"
    | "sessionParticipationTracker"
  >,
  state: ChatPageHost,
  composer: Pick<ChatProps, "canCompose" | "suggestionComposer">,
): ImageLightboxProps["onUseImage"] {
  // Suggestions are text-only and intentionally have no file-attachment workflow.
  if (!composer.canCompose || composer.suggestionComposer) {
    return undefined;
  }
  const sessionKey = state.sessionKey;
  const version = state.imageLightboxRequestVersion;
  const connectionGeneration = pane.connectionGeneration;
  return async (item, isSelected) => {
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
    const blob = item.readOriginalBlob
      ? await item.readOriginalBlob()
      : await fetchControlUiResource(item.originalSrc || item.src, {
          referrerPolicy: "no-referrer",
        }).then((response) => {
          if (!response.ok) {
            throw new Error("Image is unavailable");
          }
          return response.blob();
        });
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
    const file = new File([blob], imageFileName(item.title, mimeType), {
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
  };
}
