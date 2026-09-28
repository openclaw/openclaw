import { html, nothing } from "lit";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import {
  resolveCappedMessageId,
  type AssistantMessageExpansionState,
} from "../chat-message-recovery.ts";
import { projectChatSystemNotice } from "../chat-system-notice.ts";
import type { ChatProps } from "../chat-view.ts";
import { renderChatNotice } from "./chat-divider.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender, resolveMessageActionDetails } from "./chat-message-markdown.ts";
import { assistantMediaPolicyKey } from "./chat-message-media.ts";
import type { ChatQueueRecovery } from "./chat-queue-recovery.types.ts";

/** Read-only expansion: shared text/media policy, without reply, edit or send actions. */
export function renderChatQueueRecoveryDetails(
  input: ChatQueueRecovery["items"][number],
  inspection: AssistantMessageExpansionState | undefined,
  chat: ChatProps,
  requestUpdate: () => void,
) {
  const message =
    inspection?.status === "loaded" && inspection.message ? inspection.message : input.message;
  const key = `recovery:${input.id}`;
  const notice = projectChatSystemNotice({ kind: "message", key, message }, undefined, {
    status: input.state === "cancelled" ? "cancelled" : "interrupted",
    key: `${key}:state`,
    timestamp: input.acceptedAt,
  }).find((item) => item.kind === "notice" && item.key === key);
  if (notice?.kind === "notice") {
    return html`${renderChatNotice(notice)}${notice.text ? html`<div class="chat-group-footer-actions">${renderCopyAsMarkdownButton(notice.text)}</div>` : nothing}`;
  }
  const prepared = prepareChatMessageRender(message);
  const details = resolveMessageActionDetails(prepared, { messageId: key, senderLabel: "" });
  const capped = resolveCappedMessageId(message, prepared.normalizedMessage.role);
  return html`
    ${renderGroupedMessage(
      prepared,
      key,
      {
        isStreaming: false,
        showReasoning: false,
        showToolCalls: false,
        sessionKey: chat.sessionKey,
        agentId: chat.currentAgentId ?? chat.fullMessageAgentId,
        presented: chat.presented,
        onRequestUpdate: requestUpdate,
        resourceBasePath: chat.resourceBasePath,
        mediaPolicyKey: assistantMediaPolicyKey(chat.selectedSession, chat.mediaPolicyEpoch),
        connectionEpoch: chat.connectionEpoch,
        assistantAttachmentAuthToken: chat.assistantAttachmentAuthToken,
        resolveArtifactDownload: chat.resolveArtifactDownload,
        onRequestOpenImage: chat.onRequestOpenImage,
        onOpenImage: chat.onOpenImage,
        embedSandboxMode: "strict",
        allowExternalEmbedUrls: false,
        isUserMessageExpanded: () => true,
      },
      chat.onOpenSidebar,
    )}
    ${!capped && details?.copyMarkdown ? html`<div class="chat-group-footer-actions">${renderCopyAsMarkdownButton(details.copyMarkdown)}</div>` : nothing}
  `;
}
