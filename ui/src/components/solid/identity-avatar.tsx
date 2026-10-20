import type { JSX } from "@solidjs/web";
import { createComponent, createMemo, lazy, Loading, Show, type Accessor } from "solid-js";
import {
  isThemeAvatarHatId,
  type ThemeBranding,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { isReservedSystemAgentId } from "../../../../src/system-agent/agent-id.js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import {
  resolveAgentIdentityAvatarView,
  type AgentIdentity,
  type IdentityAvatarView,
} from "../../lib/identity-avatar-view.ts";
import type { IdentityAvatarInput } from "../../lib/identity-avatar.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { resolveAvatarHat } from "../agent-avatar-hat.ts";
import { PluginThemeArtwork } from "../plugin-theme-artwork.tsx";
import { ThemeBrandIcon } from "../theme-brand-icon.tsx";
import { AVATAR_HAT_ARTWORK } from "../theme-flair-artwork.tsx";
import { IdentityAvatarImage, createIdentityAvatarPresentation } from "./identity-avatar-image.tsx";
import { useAvatarGatewayContext, useIdentityAvatarView } from "./identity-avatar-view.ts";
import "../../styles/identity-avatar.css";

const AgentAvatarFace = lazy(() => import("../agent-avatar-face.tsx"), {
  export: "AgentAvatarFace",
});

export function AgentIdentityAvatar(props: {
  elementRef?: (element: HTMLElement) => void;
  agent: AgentIdentity;
  class?: string;
  onImageError?: () => void;
}) {
  const gateway = useAvatarGatewayContext();
  const branding = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  const view = createMemo(() => {
    gateway();
    return resolveAgentIdentityAvatarView(props.agent);
  });
  const presentation = createIdentityAvatarPresentation(view);
  return (
    <Show
      when={!isReservedSystemAgentId(props.agent.id)}
      fallback={
        <SystemAgentAvatar
          name={props.agent.name}
          class={props.class}
          branding={branding.read()}
          elementRef={props.elementRef}
        />
      }
    >
      <span
        ref={(element) => props.elementRef?.(element)}
        data-avatar-state={presentation.state()}
        class={["identity-avatar--agent", props.class, presentation.classes()]}
        role={props.agent.name ? "img" : undefined}
        aria-label={props.agent.name}
        aria-hidden={props.agent.name ? undefined : "true"}
      >
        <Show when={Boolean(view().imageUrl)}>
          <IdentityAvatarImage
            view={view()}
            onStateChange={presentation.onStateChange}
            class="identity-avatar__image"
            onImageError={props.onImageError}
          />
        </Show>
        <span class="identity-avatar__fallback">
          <Show
            when={props.agent.textAvatar}
            fallback={
              <Loading>
                <AgentAvatarFace agentId={props.agent.id} />
              </Loading>
            }
          >
            <span class="identity-avatar__text" data-avatar={props.agent.textAvatar} />
          </Show>
        </span>
        <Show when={!props.agent.pending}>
          <AgentAvatarHat agentId={props.agent.id} branding={branding.read()} />
        </Show>
      </span>
    </Show>
  );
}

export function AgentAvatarHat(props: { agentId: string; branding: ThemeBranding }) {
  const hat = createMemo(() => resolveAvatarHat(props.agentId, props.branding));
  const builtinHat = () => {
    const value = hat();
    return value && isThemeAvatarHatId(value) ? value : undefined;
  };
  return (
    <Show when={hat()}>
      {(value) => (
        <span
          class={["identity-avatar__hat", `identity-avatar__hat--${value()}`]}
          aria-hidden="true"
        >
          <Show
            when={builtinHat()}
            keyed
            fallback={
              <Show when={props.branding.artwork?.hats?.[value()]}>
                {(artwork) => (
                  <PluginThemeArtwork url={artwork().url} class="identity-avatar__hat-img" />
                )}
              </Show>
            }
          >
            {(id) => createComponent(AVATAR_HAT_ARTWORK[id], {})}
          </Show>
        </span>
      )}
    </Show>
  );
}

function SystemAgentAvatar(props: {
  name?: string;
  class?: string;
  branding: ThemeBranding;
  elementRef?: (element: HTMLElement) => void;
}) {
  return (
    <Show
      when={props.branding.brandIcon !== "claw"}
      fallback={
        <img
          ref={(element) => props.elementRef?.(element)}
          class={["identity-avatar--agent", props.class]}
          src={inferControlUiPublicAssetPath("favicon.svg")}
          alt={props.name ?? ""}
          aria-hidden={props.name ? undefined : "true"}
        />
      }
    >
      <span
        ref={(element) => props.elementRef?.(element)}
        class={["identity-avatar--agent", "identity-avatar--neutral", props.class]}
        role={props.name ? "img" : undefined}
        aria-label={props.name}
        aria-hidden={props.name ? undefined : "true"}
      >
        <ThemeBrandIcon branding={props.branding} />
      </span>
    </Show>
  );
}

export function IdentityAvatar(props: {
  identity: IdentityAvatarInput;
  children: (view: Accessor<IdentityAvatarView>) => JSX.Element;
}) {
  const view = useIdentityAvatarView(() => props.identity);
  return <>{props.children(view)}</>;
}
