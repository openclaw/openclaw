import { html, nothing, render } from "lit";
import { createEffect, createMemo, Show } from "solid-js";
import {
  isThemeAvatarHatId,
  type ThemeBranding,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { isReservedSystemAgentId } from "../../../../src/system-agent/agent-id.js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import { resolveAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { resolveAvatarHat } from "../agent-avatar-hat.ts";
import { icons } from "../icons.ts";
import { renderPluginThemeArtwork } from "../plugin-theme-artwork.ts";
import { renderThemeBrandIcon } from "../theme-brand-icon.ts";
import { AVATAR_HAT_SPRITES } from "../theme-flair-sprites.ts";
import { IdentityAvatarImage, setIdentityAvatarState } from "./identity-avatar-image.tsx";
import "../../styles/identity-avatar.css";

export { IdentityAvatarImage } from "./identity-avatar-image.tsx";

export type AgentIdentity = {
  id: string;
  name?: string;
  avatar?: string | null;
  textAvatar?: string | null;
  pending?: boolean;
};

export function AgentAvatarHat(props: { agentId: string; branding: ThemeBranding }) {
  const hat = createMemo(() => resolveAvatarHat(props.agentId, props.branding));
  let frame: HTMLSpanElement | undefined;
  createEffect(
    () => ({ hat: hat(), branding: props.branding }),
    ({ hat: selectedHat, branding }) => {
      if (!frame || !selectedHat) {
        return;
      }
      const target = frame;
      const artwork = branding.artwork?.hats?.[selectedHat];
      render(
        isThemeAvatarHatId(selectedHat)
          ? AVATAR_HAT_SPRITES[selectedHat]
          : artwork
            ? renderPluginThemeArtwork(artwork.url, "identity-avatar__hat-img")
            : nothing,
        target,
      );
      return () => render(nothing, target);
    },
  );
  return (
    <Show when={hat()}>
      <span
        ref={(element) => {
          frame = element;
        }}
        class={["identity-avatar__hat", `identity-avatar__hat--${hat()}`]}
        aria-hidden="true"
      />
    </Show>
  );
}

export function AgentIdentityAvatar(props: {
  agent: AgentIdentity;
  class?: string;
  onImageError?: () => void;
}) {
  const branding = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  const view = createMemo(() => {
    const imageUrl =
      !isReservedSystemAgentId(props.agent.id) && props.agent.avatar && !props.agent.pending
        ? (resolveAvatarImageUrl(props.agent.avatar) ?? props.agent.avatar)
        : null;
    return {
      imageUrl,
      sourceUrl: props.agent.avatar ?? undefined,
      pending: props.agent.pending ?? imageUrl !== null,
    };
  });
  let frame: HTMLSpanElement | undefined;
  let face: HTMLSpanElement | undefined;
  createEffect(
    () => ({ id: props.agent.id, text: props.agent.textAvatar }),
    ({ id, text }) => {
      if (!face) {
        return;
      }
      const target = face;
      let active = true;
      // Stateless SVG artwork stays shared with the remaining Lit callers.
      if (text) {
        render(html`<span class="identity-avatar__text" data-avatar=${text}></span>`, target);
      } else {
        render(nothing, target);
        void import("../agent-avatar-face.ts").then(({ renderAgentAvatarFace }) => {
          if (active) {
            render(renderAgentAvatarFace(id), target);
          }
        });
      }
      return () => {
        active = false;
        render(nothing, target);
      };
    },
  );
  createEffect(
    () => view(),
    (value) => {
      if (frame && !value.imageUrl) {
        setIdentityAvatarState(frame, value.pending ? "pending" : "none");
      }
    },
  );
  return (
    <Show
      when={!isReservedSystemAgentId(props.agent.id)}
      fallback={
        <SystemAgentAvatar name={props.agent.name} class={props.class} branding={branding.read()} />
      }
    >
      <span
        ref={(element) => {
          frame = element;
        }}
        class={["identity-avatar--agent", props.class]}
        role={props.agent.name ? "img" : undefined}
        aria-label={props.agent.name}
        aria-hidden={props.agent.name ? undefined : "true"}
      >
        <Show when={view().imageUrl}>
          <IdentityAvatarImage
            view={view()}
            fallbackSelector=".identity-avatar--agent"
            class="identity-avatar__image"
            onImageError={props.onImageError}
          />
        </Show>
        <span
          ref={(element) => {
            face = element;
          }}
          class="identity-avatar__fallback"
        />
        <Show when={!props.agent.pending}>
          <AgentAvatarHat agentId={props.agent.id} branding={branding.read()} />
        </Show>
      </span>
    </Show>
  );
}

function SystemAgentAvatar(props: { name?: string; class?: string; branding: ThemeBranding }) {
  let frame: HTMLSpanElement | undefined;
  createEffect(
    () => props.branding,
    (branding) => {
      if (!frame) {
        return;
      }
      const target = frame;
      render(renderThemeBrandIcon(icons.mark, branding), target);
      return () => render(nothing, target);
    },
  );
  return (
    <Show
      when={props.branding.brandIcon !== "claw"}
      fallback={
        <img
          class={["identity-avatar--agent", props.class]}
          src={inferControlUiPublicAssetPath("favicon.svg")}
          alt={props.name ?? ""}
          aria-hidden={props.name ? undefined : "true"}
        />
      }
    >
      <span
        ref={(element) => {
          frame = element;
        }}
        class={["identity-avatar--agent", "identity-avatar--neutral", props.class]}
        role={props.name ? "img" : undefined}
        aria-label={props.name}
        aria-hidden={props.name ? undefined : "true"}
      />
    </Show>
  );
}
