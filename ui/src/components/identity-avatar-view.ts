import { ContextEvent } from "@lit/context";
import { html, noChange, nothing, render, type AttributePart, type ChildPart } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { Directive, directive } from "lit/directive.js";
import { guard } from "lit/directives/guard.js";
import { until } from "lit/directives/until.js";
import { createEffect, createRoot, createSignal, flush, onCleanup } from "solid-js";
import {
  isThemeAvatarHatId,
  type ThemeBranding,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { isReservedSystemAgentId } from "../../../src/system-agent/agent-id.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../app/theme-branding.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import {
  resolveAvatar,
  resolveAvatarInitials,
  type IdentityAvatarInput,
  type ResolvedIdentityAvatar,
} from "../lib/identity-avatar.ts";
import { profileDirectory } from "../lib/profile-directory.ts";
import { resolveAvatarHat } from "./agent-avatar-hat.ts";
import "../styles/identity-avatar.css";
import { icons } from "./icons.ts";
import { renderPluginThemeArtwork } from "./plugin-theme-artwork.ts";
import {
  bindIdentityAvatarImage,
  type IdentityAvatarImageProps,
  setIdentityAvatarState as setAvatarState,
} from "./solid/identity-avatar-image.tsx";
import { renderThemeBrandIcon } from "./theme-brand-icon.ts";
import { AVATAR_HAT_SPRITES } from "./theme-flair-sprites.ts";

// The existing artwork helpers own the children of these named leaf containers.
export function avatarArtwork(read: () => unknown) {
  let target: HTMLElement;
  createEffect(read, (template) => {
    render(template, target);
  });
  onCleanup(() => render(nothing, target));
  return (element: HTMLElement) => {
    target = element;
  };
}

type IdentityAvatarFallback = Extract<ResolvedIdentityAvatar, { kind: "initials" }>;

export type IdentityAvatarView = IdentityAvatarImageProps["view"] & {
  fallback: IdentityAvatarFallback;
  pending: boolean;
};

/** Resolve one user identity consistently across the roster, profile, and chat. */
function resolveIdentityAvatarView(identity: IdentityAvatarInput): IdentityAvatarView {
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

type AvatarRenderer = (view: IdentityAvatarView) => unknown;

/** Subscribe at the existing DOM boundary so avatar layout and child selectors stay intact. */
class ProfileAvatarDirective extends AsyncDirective {
  private identity: IdentityAvatarInput = {};
  private renderer: AvatarRenderer = () => undefined;
  private context?: ApplicationContext;
  private part?: ChildPart;
  private stopContext?: () => void;
  private stopDirectory?: () => void;

  override render(identity: IdentityAvatarInput, renderer: AvatarRenderer) {
    this.identity = identity;
    this.renderer = renderer;
    return this.renderAvatar();
  }

  override update(part: ChildPart, [identity, renderer]: [IdentityAvatarInput, AvatarRenderer]) {
    this.part = part;
    // A newly cloned template is inserted after directive updates finish.
    queueMicrotask(() => this.bind());
    return this.render(identity, renderer);
  }

  private renderAvatar() {
    const gateway = this.context?.gateway;
    const identity = gateway
      ? profileDirectory(gateway).avatarIdentity(this.identity)
      : this.identity;
    return this.renderer(resolveIdentityAvatarView(identity));
  }

  private bind() {
    if (!this.isConnected || this.stopDirectory || !this.part) {
      return;
    }
    const host = this.part.options?.host;
    const target = host instanceof HTMLElement ? host : this.part.startNode?.parentElement;
    target?.dispatchEvent(
      new ContextEvent(
        applicationContext,
        target,
        (context, stop) => {
          this.stopContext = stop;
          if (this.context?.gateway !== context.gateway || !this.stopDirectory) {
            this.stopDirectory?.();
            this.context = context;
            this.stopDirectory = profileDirectory(context.gateway).subscribe(() =>
              this.setValue(this.renderAvatar()),
            );
          }
          this.setValue(this.renderAvatar());
        },
        true,
      ),
    );
  }

  protected override disconnected() {
    this.stopContext?.();
    this.stopDirectory?.();
    this.stopContext = undefined;
    this.stopDirectory = undefined;
    this.context = undefined;
  }

  protected override reconnected() {
    this.bind();
  }
}

const profileAvatar = directive(ProfileAvatarDirective);

/** Typed profile surfaces share directory availability and upgrade without adding DOM wrappers. */
export function renderIdentityAvatar(identity: IdentityAvatarInput, renderer: AvatarRenderer) {
  return identity.identity?.type === "profile"
    ? html`${profileAvatar(identity, renderer)}`
    : html`${renderer(resolveIdentityAvatarView(identity))}`;
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

// Lit keeps its direct-child image; the shared Solid binding owns resources and events.
class IdentityAvatarImageDirective extends AsyncDirective {
  private image!: HTMLImageElement;
  private input!: IdentityAvatarImageProps;
  private dispose?: () => void;
  private publish?: (input: IdentityAvatarImageProps) => void;

  override render(_input: IdentityAvatarImageProps) {
    return noChange;
  }

  override update(part: AttributePart, [input]: Parameters<this["render"]>) {
    if (!(part.element instanceof HTMLImageElement)) {
      return noChange;
    }
    this.image = part.element;
    this.input = input;
    if (this.isConnected) {
      if (this.publish) {
        this.publish(input);
      } else {
        this.mount();
      }
      flush();
    }
    return noChange;
  }

  private mount() {
    createRoot((dispose) => {
      this.dispose = dispose;
      const [input, publish] = createSignal(this.input);
      this.publish = publish;
      bindIdentityAvatarImage(input)(this.image);
    });
  }

  override disconnected() {
    this.dispose?.();
    this.dispose = undefined;
    this.publish = undefined;
  }

  override reconnected() {
    const view = this.input.view;
    if (view.sourceUrl) {
      const imageUrl = resolveAvatarImageUrl(view.sourceUrl);
      this.input = {
        ...this.input,
        view: {
          ...view,
          imageUrl: imageUrl ?? (view.imageUrl === view.sourceUrl ? view.imageUrl : null),
        },
      };
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
    src=${identityAvatarImage({ view, fallbackSelector, onImageError })}
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

export type AgentIdentity = {
  id: string;
  name?: string;
  avatar?: string | null;
  textAvatar?: string | null;
  pending?: boolean;
};

export function resolveAgentIdentityAvatarView(agent: AgentIdentity) {
  const imageUrl =
    !isReservedSystemAgentId(agent.id) && agent.avatar && !agent.pending
      ? (resolveAvatarImageUrl(agent.avatar) ?? agent.avatar)
      : null;
  return {
    imageUrl,
    sourceUrl: agent.avatar ?? undefined,
    pending: agent.pending ?? imageUrl !== null,
  };
}

export function renderAgentAvatarFallback(agent: AgentIdentity) {
  return guard([agent.id, agent.textAvatar], () =>
    until(
      agent.textAvatar
        ? html`<span class="identity-avatar__text" data-avatar=${agent.textAvatar}></span>`
        : import("./agent-avatar-face.ts").then(({ renderAgentAvatarFace }) =>
            renderAgentAvatarFace(agent.id),
          ),
      nothing,
    ),
  );
}

/** Agent images and emoji share one fallback across every surface. */
export function renderAgentIdentityAvatar(
  agent: AgentIdentity,
  className = "",
  onImageError?: () => void,
) {
  const branding = currentThemeBranding();
  if (isReservedSystemAgentId(agent.id)) {
    return html`${systemAgentAvatar(agent.name, className)}`;
  }
  const view = resolveAgentIdentityAvatarView(agent);
  return html`<span
    class=${identityAvatarClass(`identity-avatar--agent ${className}`, view)}
    role=${agent.name ? "img" : nothing}
    aria-label=${agent.name ?? nothing}
    aria-hidden=${agent.name ? nothing : "true"}
  >
    ${renderIdentityAvatarImage({ view, fallbackSelector: ".identity-avatar--agent", className: "identity-avatar__image", onImageError })}
    <span class="identity-avatar__fallback"> ${renderAgentAvatarFallback(agent)} </span>
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
  return html`<span class=${`identity-avatar__hat identity-avatar__hat--${hat}`} aria-hidden="true"
    >${renderAgentAvatarHatContents(hat, branding)}</span
  >`;
}

export function renderAgentAvatarHatContents(hat: string | null, branding: ThemeBranding) {
  if (!hat) {
    return nothing;
  }
  const artwork = branding.artwork?.hats?.[hat];
  return isThemeAvatarHatId(hat)
    ? AVATAR_HAT_SPRITES[hat]
    : artwork
      ? renderPluginThemeArtwork(artwork.url, "identity-avatar__hat-img")
      : nothing;
}
