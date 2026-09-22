import { html, noChange, nothing, type AttributePart } from "lit";
import { Directive, directive } from "lit/directive.js";
import { guard } from "lit/directives/guard.js";
import { until, UntilDirective } from "lit/directives/until.js";
import { isReservedSystemAgentId } from "../../../src/system-agent/agent-id.js";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { readAvatarGatewayContext } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import {
  resolveAvatar,
  resolveAvatarInitials,
  resolveTrustedAvatarUrl,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "../lib/identity-avatar.ts";
import "../styles/identity-avatar.css";

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

type AvatarState = "none" | "pending" | "loaded" | "failed";

function setAvatarState(element: Element, state: AvatarState) {
  element.setAttribute("data-avatar-state", state);
  element.classList.toggle("is-pending", state === "pending");
  element.classList.toggle("is-fallback", state === "none" || state === "failed");
}

class IdentityAvatarClassDirective extends Directive {
  private hasImage = false;

  override render(className: string, _view: Pick<IdentityAvatarView, "imageUrl" | "pending">) {
    return className;
  }

  override update(part: AttributePart, [className, view]: Parameters<this["render"]>) {
    if (!view.imageUrl) {
      setAvatarState(part.element, view.pending ? "pending" : "none");
    } else if (!this.hasImage) {
      setAvatarState(part.element, "pending");
    }
    this.hasImage = Boolean(view.imageUrl);
    const state = part.element.getAttribute("data-avatar-state");
    return `${className}${state === "pending" ? " is-pending" : state === "none" || state === "failed" ? " is-fallback" : ""}`;
  }
}

/** Preserve image-event state when Lit reconciles an unchanged source. */
export const identityAvatarClass = directive(IdentityAvatarClassDirective);

function settleIdentityAvatarImage(event: Event, fallbackSelector: string, failed: boolean): void {
  const image = event.currentTarget;
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  const wrapper = image.closest(fallbackSelector);
  if (wrapper) {
    setAvatarState(wrapper, failed ? "failed" : "loaded");
  }
}

// Each rendered image owns its resource until replacement or disconnect.
class IdentityAvatarImageDirective extends UntilDirective<unknown> {
  private part?: AttributePart;
  private sourceUrl?: string;
  private imageUrl: IdentityAvatarView["imageUrl"] = null;
  private release?: () => void;
  private value: unknown = nothing;
  private resolvedUrl: string | null = null;
  private fallbackSelector = "";

  override render(
    _imageUrl: IdentityAvatarView["imageUrl"],
    _sourceUrl: string | undefined,
    _fallbackSelector: string,
  ) {
    return nothing;
  }

  override update(
    part: AttributePart,
    [value, sourceUrl, fallbackSelector]: [
      IdentityAvatarView["imageUrl"],
      string | undefined,
      string,
    ],
  ) {
    // Only Gateway avatars need reacquisition; public image URLs stay on the page.
    const inputUrl = sourceUrl ?? (typeof value === "string" ? value : undefined);
    const avatarUrl = inputUrl
      ? resolveTrustedAvatarUrl(inputUrl, readAvatarGatewayContext().origin)
      : null;
    const imageUrl = avatarUrl && value === inputUrl ? resolveAvatarImageUrl(avatarUrl) : value;
    this.part = part;
    this.fallbackSelector = fallbackSelector;
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
    const result = super.update(part, [this.value, nothing]);
    this.reconcileSource(result, false);
    return result;
  }

  override setValue(value: unknown) {
    super.setValue(value);
    this.reconcileSource(value, true);
  }

  private reconcileSource(value: unknown, settled: boolean) {
    if (value === noChange || !this.part) {
      return;
    }
    const image = this.part.element;
    if (!(image instanceof HTMLImageElement)) {
      return;
    }
    const url = typeof value === "string" ? value : null;
    if (url !== this.resolvedUrl || !url) {
      this.resolvedUrl = url;
      const wrapper = image.closest(this.fallbackSelector);
      if (wrapper) {
        setAvatarState(wrapper, !url && settled ? "failed" : "pending");
      }
    }
    // Attribute directives run before src is committed; cached decodes need no new event.
    queueMicrotask(() => {
      if (
        url &&
        this.resolvedUrl === url &&
        image.getAttribute("src") === url &&
        image.complete &&
        image.naturalWidth > 0
      ) {
        const wrapper = image.closest(this.fallbackSelector);
        if (wrapper) {
          setAvatarState(wrapper, "loaded");
        }
      }
    });
  }

  override disconnected() {
    super.disconnected();
    this.release?.();
    this.release = undefined;
  }

  override reconnected() {
    if (this.part) {
      const imageUrl = this.sourceUrl ? resolveAvatarImageUrl(this.sourceUrl) : this.imageUrl;
      this.setValue(this.update(this.part, [imageUrl, this.sourceUrl, this.fallbackSelector]));
    }
    super.reconnected();
  }
}

/** Local agent and profile routes share the same authenticated image lease. */
const identityAvatarImage = directive(IdentityAvatarImageDirective);

/** Render the shared authenticated user image with its canonical event lifecycle. */
export function renderIdentityAvatarImage({
  view,
  fallbackSelector,
  className,
  alt = "",
  ariaHidden = false,
  onImageError,
}: {
  view: Pick<IdentityAvatarView, "imageUrl" | "sourceUrl">;
  fallbackSelector: string;
  className?: string;
  alt?: string;
  ariaHidden?: boolean;
  onImageError?: () => void;
}) {
  if (!view.imageUrl) {
    return nothing;
  }
  return html`<img
    class=${className ?? nothing}
    src=${identityAvatarImage(view.imageUrl, view.sourceUrl, fallbackSelector)}
    alt=${alt}
    aria-hidden=${ariaHidden ? "true" : nothing}
    referrerpolicy="no-referrer"
    @error=${(event: Event) => {
      settleIdentityAvatarImage(event, fallbackSelector, true);
      onImageError?.();
    }}
    @load=${(event: Event) => settleIdentityAvatarImage(event, fallbackSelector, false)}
  />`;
}

/** Agent images and emoji share one fallback across every surface. */
export function renderAgentIdentityAvatar(
  agent: {
    id: string;
    name?: string;
    avatar?: string | null;
    textAvatar?: string | null;
    pending?: boolean;
  },
  className = "",
  onImageError?: () => void,
) {
  if (isReservedSystemAgentId(agent.id)) {
    return html`<img
      class=${`identity-avatar--agent ${className}`}
      src=${inferControlUiPublicAssetPath("favicon.svg")}
      alt=${agent.name ?? ""}
      aria-hidden=${agent.name ? nothing : "true"}
    />`;
  }
  const imageUrl =
    agent.avatar && !agent.pending ? (resolveAvatarImageUrl(agent.avatar) ?? agent.avatar) : null;
  const view = {
    imageUrl,
    sourceUrl: agent.avatar ?? undefined,
    pending: agent.pending ?? imageUrl !== null,
  };
  return html`<span
    class=${identityAvatarClass(`identity-avatar--agent ${className}`, view)}
    role=${agent.name ? "img" : nothing}
    aria-label=${agent.name ?? nothing}
    aria-hidden=${agent.name ? nothing : "true"}
  >
    ${renderIdentityAvatarImage({ view, fallbackSelector: ".identity-avatar--agent", className: "identity-avatar__image", onImageError })}
    <span class="identity-avatar__fallback">
      ${guard([agent.id, agent.textAvatar], () =>
        until(
          agent.textAvatar
            ? html`<span class="identity-avatar__text" data-avatar=${agent.textAvatar}></span>`
            : import("./agent-avatar-face.ts").then(({ renderAgentAvatarFace }) =>
                renderAgentAvatarFace(agent.id),
              ),
          nothing,
        ),
      )}
    </span>
  </span>`;
}
