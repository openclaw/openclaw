import { dynamic } from "@solidjs/web";
import { createComponent, createMemo, Show } from "solid-js";
import type { ThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import { isReservedSystemAgentId } from "../../../../src/system-agent/agent-id.js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { resolveAvatarHat } from "../agent-avatar-hat.ts";
import {
  avatarArtwork,
  renderAgentAvatarFallback,
  renderAgentAvatarHatContents,
  resolveAgentIdentityAvatarView,
  type AgentIdentity,
} from "../identity-avatar-view.ts";
import "../theme-brand-icon.ts";
import { Icon } from "./icon.tsx";
import { IdentityAvatarImage, identityAvatarState } from "./identity-avatar-image.tsx";
import "../../styles/identity-avatar.css";

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
  const view = createMemo(() => resolveAgentIdentityAvatarView(props.agent));
  const hat = createMemo(() => resolveAvatarHat(props.agent.id, branding.read()));
  return (
    <Show
      when={!isReservedSystemAgentId(props.agent.id)}
      fallback={
        <SystemAgentAvatar name={props.agent.name} class={props.class} branding={branding.read()} />
      }
    >
      <span
        ref={identityAvatarState(view)}
        class={["identity-avatar--agent", props.class]}
        role={props.agent.name ? "img" : undefined}
        aria-label={props.agent.name}
        aria-hidden={props.agent.name ? undefined : "true"}
      >
        <Show when={Boolean(view().imageUrl)}>
          <IdentityAvatarImage
            view={view()}
            fallbackSelector=".identity-avatar--agent"
            class="identity-avatar__image"
            onImageError={props.onImageError}
          />
        </Show>
        <span
          ref={avatarArtwork(() => renderAgentAvatarFallback(props.agent))}
          class="identity-avatar__fallback"
        />
        <Show when={!props.agent.pending && hat()}>
          <span
            ref={avatarArtwork(() => renderAgentAvatarHatContents(hat(), branding.read()))}
            class={["identity-avatar__hat", `identity-avatar__hat--${hat()}`]}
            aria-hidden="true"
          />
        </Show>
      </span>
    </Show>
  );
}

const ThemeIcon = dynamic(() => "openclaw-theme-brand-icon");

function SystemAgentAvatar(props: { name?: string; class?: string; branding: ThemeBranding }) {
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
        class={["identity-avatar--agent", "identity-avatar--neutral", props.class]}
        role={props.name ? "img" : undefined}
        aria-label={props.name}
        aria-hidden={props.name ? undefined : "true"}
      >
        <Show
          when={props.branding.brandIcon === "mark"}
          fallback={createComponent(ThemeIcon, {
            get "prop:branding"() {
              return props.branding;
            },
            "aria-hidden": "true",
          })}
        >
          <Icon name="mark" />
        </Show>
      </span>
    </Show>
  );
}
