import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readChatTranscriptAttachmentSource } from "./chat-history-state.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { persistedMessageEntryId } from "./chat-thread-items.ts";
import type { ChatProps } from "./chat-view.tsx";
import { assistantMediaPolicyKey } from "./components/chat-message-media.ts";
import { getTranscriptState } from "./components/chat-thread-interactions.ts";
import { projectTranscriptAttachments } from "./components/chat-transcript-attachments.ts";

export function filesJump(
  chat: ChatProps,
  mobile: { close: () => void } | null | undefined,
  visible: boolean,
  open: (slot: "conversation") => void,
) {
  const access = chat.replyMessageAccess;
  return access
    ? (id: string) => {
        if (mobile) {
          mobile.close();
        } else if (!visible) {
          open("conversation");
        }
        access.open(id);
      }
    : undefined;
}

export class PaneAttachmentCatalog {
  private catalog?: {
    scope: readonly unknown[];
    inputs?: readonly unknown[];
    chat: ChatProps;
    showMessage?: (id: string) => void;
    value?: ReturnType<typeof projectTranscriptAttachments>;
  };

  dispose(): void {
    this.catalog = undefined;
  }

  read(input: {
    state: ChatPageHost;
    selectedSession: GatewaySessionRow | undefined;
    currentAgentId: string;
    chatProps: ChatProps;
    paneChatProps: ChatProps;
    gateway: ApplicationContext["gateway"];
    presentation: "desktop" | "mobile" | undefined;
    workspacePresented: boolean;
    showMessage?: (id: string) => void;
    sessionWorkspace: ReturnType<typeof createChatPaneRails>["sessionWorkspace"];
  }) {
    const {
      state,
      selectedSession,
      currentAgentId,
      chatProps,
      paneChatProps,
      gateway,
      presentation,
      workspacePresented,
      sessionWorkspace,
    } = input;
    const mediaPolicyKey = assistantMediaPolicyKey(selectedSession, chatProps.mediaPolicyEpoch);
    const attachmentScope = [
      state,
      state.client,
      state.connected,
      gateway,
      chatProps.gatewayScope,
      chatProps.sessionKey,
      state.currentSessionId,
      currentAgentId,
      chatProps.paneId,
      chatProps.connectionEpoch,
      mediaPolicyKey,
      chatProps.resourceBasePath,
      chatProps.assistantAttachmentAuthToken,
      chatProps.mediaOwner,
      chatProps.mediaReadAllowed,
      chatProps.onRequestOpenImage,
      chatProps.onOpenImage,
      chatProps.onOpenSidebar,
      Boolean(chatProps.resolveArtifactDownload),
      Boolean(chatProps.onFindWorkspaceFile),
      Boolean(input.showMessage),
    ];
    if (
      !this.catalog ||
      attachmentScope.some((value, index) => value !== this.catalog!.scope[index])
    ) {
      this.catalog = { scope: attachmentScope, chat: paneChatProps };
    }
    const attachmentCatalog = this.catalog;
    // Fresh render closures forward to the live pane within this exact media scope.
    // A retired scope retains its own callbacks, never those of the next session.
    attachmentCatalog.chat = paneChatProps;
    attachmentCatalog.showMessage = input.showMessage;
    const workspaceState = state.sessionWorkspaceState;
    const activePreview = workspaceState?.previews.find(
      (entry) => entry.id === workspaceState.activePreviewId,
    );
    const catalogPresented =
      workspacePresented &&
      (!workspaceState?.activePreviewId ||
        activePreview?.catalogVisible === true ||
        (presentation === "desktop" && sessionWorkspace.navigation?.treeVisible));
    if (catalogPresented) {
      const loaded = readChatTranscriptAttachmentSource(state);
      const snapshot = workspaceState?.artifacts?.attachments;
      const source =
        snapshot && snapshot.sessionId === loaded.sessionId
          ? {
              ...loaded,
              messages: snapshot.messages,
              coverage: snapshot.truncated ? ("partial" as const) : ("complete" as const),
              loading: false,
              error: undefined,
            }
          : loaded;
      // publishChatSessionProjection preserves the array for run-only changes and
      // replaces it for adopted/streamed row changes. No message scan is needed here.
      const tail =
        snapshot?.truncated && snapshot.sessionId === loaded.sessionId
          ? loaded.messages
          : undefined;
      const inputs = [source.messages, source.coverage, source.loading, source.error, tail];
      if (
        !attachmentCatalog.inputs ||
        inputs.some((value, index) => value !== attachmentCatalog.inputs![index])
      ) {
        // A bounded snapshot still augments the loaded window, never hides its recent files.
        const covered = tail
          ? new Set(source.messages.map(persistedMessageEntryId).filter(Boolean))
          : undefined;
        attachmentCatalog.value = projectTranscriptAttachments(
          tail && covered
            ? {
                ...source,
                messages: [
                  ...source.messages,
                  ...tail.filter((message) => !covered.has(persistedMessageEntryId(message))),
                ],
              }
            : source,
          {
            sessionKey: chatProps.sessionKey,
            showMessage: input.showMessage
              ? (id) => {
                  if (this.catalog === attachmentCatalog) {
                    attachmentCatalog.showMessage?.(id);
                  }
                }
              : undefined,
            agentId: currentAgentId,
            mediaPolicyKey,
            connectionEpoch: chatProps.connectionEpoch,
            resourceBasePath: chatProps.resourceBasePath,
            assistantAttachmentAuthToken: chatProps.assistantAttachmentAuthToken,
            mediaOwner: chatProps.mediaOwner,
            mediaReadAllowed: chatProps.mediaReadAllowed,
            onRequestOpenImage: chatProps.onRequestOpenImage,
            onOpenImage: chatProps.onOpenImage,
            onFindWorkspaceFile: chatProps.onFindWorkspaceFile
              ? (target) => attachmentCatalog.chat.onFindWorkspaceFile?.(target)
              : undefined,
            resolveArtifactDownload: chatProps.resolveArtifactDownload
              ? (request, signal) =>
                  attachmentCatalog.chat.resolveArtifactDownload!(request, signal)
              : undefined,
            getThreadMediaMessages: (key) =>
              getTranscriptState(chatProps.paneId).transcriptRenderContext.threadMediaMessages?.get(
                key,
              ),
          },
          (content) => attachmentCatalog.chat.onOpenSidebar?.(content),
        );
        attachmentCatalog.inputs = inputs;
      }
    }
    return attachmentCatalog.value;
  }
}
