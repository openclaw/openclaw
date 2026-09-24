import { html } from "lit";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { showToast } from "../lib/toast.ts";
import "../styles/mention-notifications.css";
import { renderMentionExcerpt } from "./mention-excerpt.ts";
import "./viewer-facepile.ts";

registerSidebarAttentionEnglish();

/** Loaded only for a new, non-visible mention; keeps notification UI out of startup. */
export function showMentionNotification(
  mention: MentionInboxItem,
  context: ApplicationContext,
  signal: AbortSignal,
  onDismiss: () => void,
) {
  showToast({
    icon: html`<span class="mention-toast__avatar">
      <openclaw-viewer-avatar
        .user=${{ id: mention.senderProfileId, identity: { type: "profile", id: mention.senderProfileId }, name: mention.senderLabel, avatarUrl: mention.senderAvatarUrl, watchedSessions: [] }}
        .markAsViewer=${false}
        variant="footer"
      ></openclaw-viewer-avatar>
    </span>`,
    title: html`
      <span class="mention-toast__sender-line">
        <bdi class="mention-toast__name" title=${mention.senderLabel}>${mention.senderLabel}</bdi>
        <span class="mention-toast__reason">${t("attention.mentions.mentionedYou")}</span>
      </span>
      <span class="mention-toast__session" title=${mention.sessionTitle} dir="auto"
        >${mention.sessionTitle}</span
      >
    `,
    message: html`<span class="mention-toast__excerpt" title=${mention.excerpt ?? ""} dir="auto"
      >${renderMentionExcerpt(mention.excerpt ?? t("attention.mentions.noExcerpt"), mention.excerptMention)}</span
    >`,
    actionLabel: t("attention.mentions.viewSession"),
    onAction: () => {
      const target = sessionNavigationTarget({
        face: "chat",
        sessionKey: mention.sessionKey,
        fallbackAgentId: mention.agentId,
        basePath: context.basePath,
        row: { key: mention.sessionKey, displayName: mention.sessionTitle },
        exactKey: true,
      });
      context.navigate("chat", target.options);
    },
    // Closing this transient surface never dismisses the shared Inbox entry.
    onDismiss,
    signal,
    durationMs: 5_000,
    fifo: true,
  });
}
