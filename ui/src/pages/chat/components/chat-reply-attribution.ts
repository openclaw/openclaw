import { html, nothing } from "lit";
import "./chat-attribution.css";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatSenderLabel, type SenderIdentity } from "../../../lib/chat/sender-label.ts";

export function renderChatReplyAttribution(sender: SenderIdentity | undefined) {
  const label = formatSenderLabel(sender);
  if (!label) {
    return nothing;
  }
  const title = t("chat.messages.replyingTo", { name: label });
  return html`<div class="chat-reply-attribution" title=${title} aria-label=${title}>
    <span class="chat-reply-attribution__icon" aria-hidden="true">${icons.cornerDownLeft}</span>
    <span>${label}</span>
  </div>`;
}
