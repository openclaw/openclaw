import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readChatTranscriptAttachmentSource } from "./chat-history-state.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.tsx";
import { assistantMediaPolicyKey } from "./components/chat-message-media.ts";
import { getTranscriptState } from "./components/chat-thread-interactions.ts";
import { projectTranscriptAttachments } from "./components/chat-transcript-attachments.ts";

export class PaneAttachmentCatalog {
  private catalog?: {
    scope: readonly unknown[];
    inputs?: readonly unknown[];
    chat: ChatProps;
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
      chatProps.onRequestOpenImage,
      chatProps.onOpenImage,
      chatProps.onOpenSidebar,
      Boolean(chatProps.resolveArtifactDownload),
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
      const source = readChatTranscriptAttachmentSource(state);
      // publishChatSessionProjection preserves the array for run-only changes and
      // replaces it for adopted/streamed row changes. No message scan is needed here.
      const inputs = [source.messages, source.coverage, source.loading, source.error];
      if (
        !attachmentCatalog.inputs ||
        inputs.some((value, index) => value !== attachmentCatalog.inputs![index])
      ) {
        attachmentCatalog.value = projectTranscriptAttachments(
          source,
          {
            sessionKey: chatProps.sessionKey,
            agentId: currentAgentId,
            mediaPolicyKey,
            connectionEpoch: chatProps.connectionEpoch,
            resourceBasePath: chatProps.resourceBasePath,
            assistantAttachmentAuthToken: chatProps.assistantAttachmentAuthToken,
            mediaOwner: chatProps.mediaOwner,
            onRequestOpenImage: chatProps.onRequestOpenImage,
            onOpenImage: chatProps.onOpenImage,
            resolveArtifactDownload: chatProps.resolveArtifactDownload
              ? (request, signal) =>
                  attachmentCatalog.chat.resolveArtifactDownload!(request, signal)
              : undefined,
            getTurnVideoMessages: (key) =>
              getTranscriptState(chatProps.paneId).transcriptRenderContext.turnVideoMessages?.get(
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
