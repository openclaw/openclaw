import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { readChatTranscriptAttachmentSource } from "./chat-history-state.ts";
import { resolveCappedMessageId } from "./chat-message-recovery.ts";
import type { createChatPaneRails } from "./chat-pane-rails.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { persistedMessageEntryId } from "./chat-thread-items.ts";
import type { ChatProps } from "./chat-view.tsx";
import { assistantMediaPolicyKey } from "./components/chat-message-media.ts";
import type { SessionWorkspaceArtifacts } from "./components/chat-session-workspace-types.ts";
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

/** Keep the catalog's richer media references for unchanged rows. New live versions
 * replace the same durable message in place, including when an upload is removed. */
function overlayAttachmentMessages(
  snapshot: NonNullable<SessionWorkspaceArtifacts["attachments"]>,
  live: readonly unknown[],
): unknown[] {
  const messages = snapshot.messages.slice();
  const positions = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    const id = persistedMessageEntryId(message);
    if (id) {
      positions.set(id, index);
    }
  }
  for (const message of live) {
    const id = persistedMessageEntryId(message);
    const position = id ? positions.get(id) : undefined;
    if (
      message &&
      typeof message === "object" &&
      snapshot.atRequest.has(message) &&
      ((!snapshot.truncated && id !== null) || position !== undefined)
    ) {
      continue;
    }
    if (position === undefined) {
      messages.push(message);
    } else {
      // A history refresh can adopt a display-capped copy of an already cataloged upload.
      const normalized = normalizeMessage(message);
      if (
        !resolveCappedMessageId(message, normalized.role) &&
        !normalized.content.some((item) => item.type === "omitted_media")
      ) {
        messages[position] = message;
      }
    }
  }
  return messages;
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
      const current = snapshot?.sessionId === loaded.sessionId ? snapshot : undefined;
      const inputs = [current, loaded.messages, loaded.coverage, loaded.loading, loaded.error];
      if (
        !attachmentCatalog.inputs ||
        inputs.some((value, index) => value !== attachmentCatalog.inputs![index])
      ) {
        const source = current
          ? {
              ...loaded,
              messages: overlayAttachmentMessages(
                current,
                loaded.coverage === "unknown" ? [] : loaded.messages,
              ),
              coverage: current.truncated ? ("partial" as const) : ("complete" as const),
              loading: false,
              error: undefined,
            }
          : loaded;
        attachmentCatalog.value = projectTranscriptAttachments(
          source,
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
