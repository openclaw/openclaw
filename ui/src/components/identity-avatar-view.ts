import { html, svg, nothing, type Part } from "lit";
import { directive } from "lit/directive.js";
import { guard } from "lit/directives/guard.js";
import { live } from "lit/directives/live.js";
import { UntilDirective } from "lit/directives/until.js";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import { readAvatarGatewayContext } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import {
  resolveAvatar,
  resolveAvatarInitials,
  resolveTrustedAvatarUrl,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "../lib/identity-avatar.ts";

type IdentityAvatarFallback = Extract<ResolvedIdentityAvatar, { kind: "initials" }>;

export type IdentityAvatarView = {
  fallback: IdentityAvatarFallback;
  imageUrl: string | Promise<string | null> | null;
  sourceUrl?: string;
  pending: boolean;
};

/** Resolve one user identity consistently across the roster, profile, and chat. */
export function resolveIdentityAvatarView(identity: IdentityAvatarInput): IdentityAvatarView {
  const avatar = resolveAvatar(identity);
  const fallback = avatar.kind === "initials" ? avatar : resolveAvatarInitials(identity);
  const imageUrl = avatar.kind === "profile" ? resolveAvatarImageUrl(avatar.url) : null;
  return {
    fallback,
    imageUrl,
    sourceUrl: avatar.kind === "profile" ? avatar.url : undefined,
    pending: imageUrl !== null && typeof imageUrl !== "string",
  };
}

/** Reconcile changed images without overwriting event fallback on unchanged rerenders. */
export function identityAvatarClass(className: string, view: IdentityAvatarView) {
  return guard([className, view.imageUrl, view.pending], () =>
    live(`${className}${view.pending ? " is-fallback" : ""}`),
  );
}

function settleIdentityAvatarImage(event: Event, fallbackSelector: string, failed: boolean): void {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  image.closest<HTMLElement>(fallbackSelector)?.classList.toggle("is-fallback", failed);
}

// Each rendered image owns its resource until replacement or disconnect.
class IdentityAvatarImageDirective extends UntilDirective<unknown> {
  private part?: Part;
  private sourceUrl?: string;
  private imageUrl: IdentityAvatarView["imageUrl"] = null;
  private release?: () => void;
  private value: unknown = nothing;

  override render(_imageUrl: IdentityAvatarView["imageUrl"], _sourceUrl?: string) {
    return nothing;
  }

  override update(part: Part, [value, sourceUrl]: [IdentityAvatarView["imageUrl"], string?]) {
    // Only Gateway avatars need reacquisition; public image URLs stay on the page.
    const inputUrl = sourceUrl ?? (typeof value === "string" ? value : undefined);
    const avatarUrl = inputUrl
      ? resolveTrustedAvatarUrl(inputUrl, readAvatarGatewayContext().origin)
      : null;
    const imageUrl = avatarUrl && value === inputUrl ? resolveAvatarImageUrl(avatarUrl) : value;
    this.part = part;
    this.sourceUrl = avatarUrl ?? undefined;
    if (imageUrl !== this.imageUrl || !this.release) {
      const release = this.isConnected ? retainAvatarImageUrl(imageUrl) : undefined;
      this.release?.();
      this.release = release;
      this.imageUrl = imageUrl;
      this.value =
        typeof imageUrl === "string"
          ? imageUrl
          : (imageUrl?.then((url) => url ?? nothing) ?? nothing);
    }
    return super.update(part, [this.value, nothing]);
  }

  override disconnected() {
    super.disconnected();
    this.release?.();
    this.release = undefined;
  }

  override reconnected() {
    if (this.part) {
      const imageUrl = this.sourceUrl ? resolveAvatarImageUrl(this.sourceUrl) : this.imageUrl;
      this.setValue(this.update(this.part, [imageUrl, this.sourceUrl]));
    }
    super.reconnected();
  }
}

/** Local agent and profile routes share the same authenticated image lease. */
export const identityAvatarImage = directive(IdentityAvatarImageDirective);

/** Render the shared authenticated user image with its canonical event lifecycle. */
export function renderIdentityAvatarImage({
  view,
  fallbackSelector,
  className,
  alt = "",
  ariaHidden = false,
}: {
  view: IdentityAvatarView;
  fallbackSelector: string;
  className?: string;
  alt?: string;
  ariaHidden?: boolean;
}) {
  if (!view.imageUrl) {
    return nothing;
  }
  return html`<img
    class=${className ?? nothing}
    src=${identityAvatarImage(view.imageUrl, view.sourceUrl)}
    alt=${alt}
    aria-hidden=${ariaHidden ? "true" : nothing}
    referrerpolicy="no-referrer"
    @error=${(event: Event) => settleIdentityAvatarImage(event, fallbackSelector, true)}
    @load=${(event: Event) => settleIdentityAvatarImage(event, fallbackSelector, false)}
  />`;
}

/** Agent artwork shares the identity renderer; explicit images/text win at the caller. */
export function renderAgentAvatarFallback(agentId: string) {
  const seed = fnv1aUtf16(agentId);
  const ears =
    seed % 2 === 0
      ? svg`<path d="M7 15V6l7 5h4l7-5v9" />`
      : svg`<path d="M8 14Q3 7 8 6q5 0 6 6h4q1-6 6-6 5 1 0 8" />`;
  return html`<svg
    class="identity-avatar__agent-face"
    viewBox="0 0 32 32"
    aria-hidden="true"
    style=${`--identity-hue: ${seed % 360}`}
  >
    ${svg`<rect width="32" height="32" rx="11" fill="currentColor" opacity=".14" />
    <g fill="currentColor" opacity=".4">${ears}<rect x="6" y="11" width="20" height="17" rx="9" /></g>
    <g fill="currentColor"><circle cx="12" cy="17" r="1.5" /><circle cx="20" cy="17" r="1.5" /></g>
    <path d="M13 22q3 3 6 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />`}
  </svg>`;
}
