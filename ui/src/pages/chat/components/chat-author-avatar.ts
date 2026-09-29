import { html, nothing, type TemplateResult } from "lit";
import {
  identityAvatarClass,
  renderAgentIdentityAvatar,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
  type IdentityAvatarView,
} from "../../../components/identity-avatar-view.ts";
import { formatSenderLabel } from "../../../lib/chat/sender-label.ts";
import {
  resolveAvatar,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "../../../lib/identity-avatar.ts";

function renderInitialsAvatar(
  avatar: Extract<ResolvedIdentityAvatar, { kind: "initials" }>,
  fallback = false,
) {
  const hue = avatar.colorSeed % 360;
  return html`
    <span
      class="chat-author-avatar__initials ${fallback ? "chat-author-avatar__fallback" : ""}"
      style=${`--chat-author-avatar-hue: ${hue}`}
      aria-hidden="true"
    >
      ${avatar.initials}
    </span>
  `;
}

function renderResolvedAvatar(view: IdentityAvatarView): TemplateResult {
  if (!view.imageUrl) {
    return renderInitialsAvatar(view.fallback);
  }
  return html`
    ${renderIdentityAvatarImage({
      view,
      fallbackSelector: ".chat-author-avatar",
      className: "chat-author-avatar__image",
      ariaHidden: true,
    })}${renderInitialsAvatar(view.fallback, true)}
  `;
}

/** Small author marker shared by transcript bubbles and the pending-send queue. */
export function renderChatAuthorAvatar(
  sender: IdentityAvatarInput | null | undefined,
  className = "chat-author-avatar",
): TemplateResult | typeof nothing {
  const label = formatSenderLabel(sender);
  if (!sender || !label) {
    return nothing;
  }
  if (sender.identity?.type === "agent") {
    const avatar = resolveAvatar(sender);
    return html`<span class=${className} role="img" aria-label=${label} title=${label}>
      ${renderAgentIdentityAvatar({
        id: sender.identity.id,
        avatar: avatar.kind === "profile" ? avatar.url : null,
      })}
    </span>`;
  }
  const view = resolveIdentityAvatarView(sender);
  const resolved = renderResolvedAvatar(view);
  return html`<span
    class=${identityAvatarClass("chat-author-avatar", view)}
    role="img"
    aria-label=${label}
    title=${label}
  >
    ${resolved}
  </span>`;
}

export function resolveChatDefaultAvatarPlacement(
  isDirectSession: boolean,
  userId?: string | null,
): "footer" | "gutter" {
  return isDirectSession && !userId ? "footer" : "gutter";
}

/**
 * The avatar URL may 404 or be unreachable (missing upload, dead Gravatar,
 * stale configured URL); swap to initials instead of a broken image. Lit
 * reuses DOM parts, so a load must clear a prior identity's error state.
 */
export function renderUserAvatarSlot(view: IdentityAvatarView, label: string, role = "user") {
  const initialsAvatar = html`<div
    class="chat-avatar ${role} chat-avatar--sender-initials"
    style=${`background: hsl(${view.fallback.colorSeed % 360} 48% 42%)`}
    role="img"
    aria-label="${label}"
  >
    ${view.fallback.initials}
  </div>`;
  if (!view.imageUrl) {
    return initialsAvatar;
  }
  return html`<span class=${identityAvatarClass("chat-avatar-slot", view)}>
    ${renderIdentityAvatarImage({
      view,
      fallbackSelector: ".chat-avatar-slot",
      className: `chat-avatar ${role}`,
      alt: label,
    })}${initialsAvatar}
  </span>`;
}
