import { html, noChange, nothing, type AttributePart } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { Directive, directive } from "lit/directive.js";
import { guard } from "lit/directives/guard.js";
import { until } from "lit/directives/until.js";
import { createRoot, createSignal, flush } from "solid-js";
import {
  isThemeAvatarHatId,
  type ThemeBranding,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { isReservedSystemAgentId } from "../../../src/system-agent/agent-id.js";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../app/theme-branding.ts";
import { readAvatarGatewayContext } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import {
  resolveAvatar,
  resolveAvatarInitials,
  resolveTrustedAvatarUrl,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "../lib/identity-avatar.ts";
import { resolveAvatarHat } from "./agent-avatar-hat.ts";
import "../styles/identity-avatar.css";
import { icons } from "./icons.ts";
import { renderPluginThemeArtwork } from "./plugin-theme-artwork.ts";
import {
  IdentityAvatarImage,
  setIdentityAvatarState as setAvatarState,
} from "./solid/identity-avatar-image.tsx";
import { renderThemeBrandIcon } from "./theme-brand-icon.ts";
import { AVATAR_HAT_SPRITES } from "./theme-flair-sprites.ts";

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

// Lit supplies the existing image node; the Solid component owns every resource and event.
class IdentityAvatarImageDirective extends AsyncDirective {
  private part?: AttributePart;
  private view: Pick<IdentityAvatarView, "imageUrl" | "sourceUrl"> = { imageUrl: null };
  private fallbackSelector = "";
  private onImageError?: () => void;
  private dispose?: () => void;
  private publish?: (view: Pick<IdentityAvatarView, "imageUrl" | "sourceUrl">) => void;

  override render(
    _imageUrl: IdentityAvatarView["imageUrl"],
    _sourceUrl: string | undefined,
    _fallbackSelector: string,
    _onImageError?: () => void,
  ) {
    return noChange;
  }

  override update(
    part: AttributePart,
    [imageUrl, sourceUrl, fallbackSelector, onImageError]: Parameters<this["render"]>,
  ) {
    this.part = part;
    this.view = { imageUrl, sourceUrl };
    this.fallbackSelector = fallbackSelector;
    this.onImageError = onImageError;
    if (this.isConnected) {
      if (this.publish) {
        this.publish(this.view);
      } else {
        this.mount();
      }
      flush();
    }
    return noChange;
  }

  private mount() {
    const image = this.part?.element;
    if (!(image instanceof HTMLImageElement)) {
      return;
    }
    const source = this.view.sourceUrl;
    const trusted = source
      ? resolveTrustedAvatarUrl(source, readAvatarGatewayContext().origin)
      : null;
    createRoot((dispose) => {
      this.dispose = dispose;
      const [view, publish] = createSignal(this.view);
      this.publish = publish;
      const selector = () => this.fallbackSelector;
      const onError = () => this.onImageError?.();
      IdentityAvatarImage({
        element: image,
        get view() {
          return view();
        },
        get fallbackSelector() {
          return selector();
        },
        onImageError: onError,
      });
    });
    this.view = { ...this.view, sourceUrl: trusted ?? undefined };
  }

  override disconnected() {
    this.dispose?.();
    this.dispose = undefined;
    this.publish = undefined;
  }

  override reconnected() {
    if (this.view.sourceUrl) {
      this.view = { ...this.view, imageUrl: resolveAvatarImageUrl(this.view.sourceUrl) };
    }
    this.mount();
    flush();
  }
}

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
    src=${identityAvatarImage(view.imageUrl, view.sourceUrl, fallbackSelector, onImageError)}
    alt=${alt}
    aria-hidden=${ariaHidden ? "true" : nothing}
    referrerpolicy="no-referrer"
  />`;
}

function renderSystemAgentAvatar(name: string | undefined, className: string) {
  const branding = currentThemeBranding();
  if (branding.brandIcon !== "claw") {
    return html`<span
      class=${`identity-avatar--agent identity-avatar--neutral ${className}`}
      role=${name ? "img" : nothing}
      aria-label=${name ?? nothing}
      aria-hidden=${name ? nothing : "true"}
      >${renderThemeBrandIcon(icons.mark, branding)}</span
    >`;
  }
  return html`<img
    class=${`identity-avatar--agent ${className}`}
    src=${inferControlUiPublicAssetPath("favicon.svg")}
    alt=${name ?? ""}
    aria-hidden=${name ? nothing : "true"}
  />`;
}

/** Reserved avatars update even when their identity-owning host has no new data. */
class SystemAgentAvatarDirective extends AsyncDirective {
  private name?: string;
  private className = "";
  private stop?: () => void;

  override render(name: string | undefined, className: string) {
    this.name = name;
    this.className = className;
    if (this.isConnected) {
      this.stop ??= subscribeThemeBranding(() =>
        this.setValue(renderSystemAgentAvatar(this.name, this.className)),
      );
    }
    return renderSystemAgentAvatar(name, className);
  }

  protected override disconnected(): void {
    this.stop?.();
    this.stop = undefined;
  }

  protected override reconnected(): void {
    this.setValue(this.render(this.name, this.className));
  }
}

const systemAgentAvatar = directive(SystemAgentAvatarDirective);

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
  const branding = currentThemeBranding();
  if (isReservedSystemAgentId(agent.id)) {
    return html`${systemAgentAvatar(agent.name, className)}`;
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
    ${agent.pending ? nothing : renderAgentAvatarHat(agent.id, branding)}
  </span>`;
}

export function renderAgentAvatarHat(
  agentId: string,
  branding: ThemeBranding = currentThemeBranding(),
) {
  const hat = resolveAvatarHat(agentId, branding);
  if (!hat) {
    return nothing;
  }
  const artwork = branding.artwork?.hats?.[hat];
  const sprite = isThemeAvatarHatId(hat)
    ? AVATAR_HAT_SPRITES[hat]
    : artwork
      ? renderPluginThemeArtwork(artwork.url, "identity-avatar__hat-img")
      : nothing;
  return html`<span class=${`identity-avatar__hat identity-avatar__hat--${hat}`} aria-hidden="true"
    >${sprite}</span
  >`;
}
