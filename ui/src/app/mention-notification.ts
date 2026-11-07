import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { sessionViewerPresenceForGateway } from "../lib/session-viewer-presence.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { showToast } from "../lib/toast.ts";
import type { ApplicationContext } from "./context.ts";

/** Marks the recipient's own selected mention; text nodes keep the excerpt inert. */
function mentionExcerpt({ excerpt, excerptHighlight: range }: MentionInboxItem) {
  if (!excerpt || !range) {
    return excerpt;
  }
  const preview = document.createElement("span");
  const mark = document.createElement("mark");
  mark.className = "app-toast__mention";
  mark.textContent = excerpt.slice(range.start, range.end);
  preview.append(excerpt.slice(0, range.start), mark, excerpt.slice(range.end));
  return preview;
}

registerEnglishCatalog(registerSidebarAttentionEnglish);

export function showMentionNotification(
  context: Pick<ApplicationContext, "gateway" | "basePath" | "navigate">,
  mention: MentionInboxItem,
  signal: AbortSignal,
) {
  if (
    signal.aborted ||
    sessionViewerPresenceForGateway(context.gateway).isViewing(mention.sessionKey)
  ) {
    return;
  }
  const target = sessionNavigationTarget({
    face: "chat",
    sessionKey: mention.sessionKey,
    fallbackAgentId: mention.agentId,
    basePath: context.basePath,
    row: { key: mention.sessionKey, displayName: mention.sessionTitle },
    exactKey: true,
  });
  showToast({
    severity: undefined,
    placement: "top-right",
    message: `${mention.senderLabel} · ${mention.sessionTitle}`,
    description: mentionExcerpt(mention),
    avatar: {
      kind: "human",
      user: {
        id: mention.senderProfileId,
        identity: { type: "profile", id: mention.senderProfileId },
        name: mention.senderLabel,
        avatarUrl: mention.senderAvatarUrl,
        watchedSessions: [],
      },
    },
    durationMs: 5_000,
    signal,
    actionLabel: t("attention.mentions.viewSession"),
    actionHref: target.href,
    onAction: () => context.navigate("chat", target.options),
  });
}
