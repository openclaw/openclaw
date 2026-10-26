import type { JSX } from "@solidjs/web";
import { createMemo, Errored, lazy, Loading, Show, type Accessor } from "solid-js";
import {
  isThemeAvatarHatId,
  type ThemeBranding,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { isReservedSystemAgentId } from "../../../../src/system-agent/agent-id.js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  resolveAgentIdentityAvatarView,
  type AgentIdentity,
  type IdentityAvatarView,
} from "../../lib/identity-avatar-view.ts";
import type { IdentityAvatarInput } from "../../lib/identity-avatar.ts";
import { themeBrandingProjection } from "../../lib/reactive/theme-branding.ts";
import { resolveAvatarHat } from "../agent-avatar-hat.ts";
import type { AgentSelectOption } from "../agent-select-types.ts";
import { PluginThemeArtwork } from "../plugin-theme-artwork.tsx";
import { ThemeBrandIcon } from "../theme-brand-icon.tsx";
import { AVATAR_HAT_ARTWORK } from "../theme-flair-artwork.tsx";
import { Icon } from "./icon.tsx";
import { IdentityAvatarImage, createIdentityAvatarPresentation } from "./identity-avatar-image.tsx";
import { useAvatarGatewayContext, useIdentityAvatarView } from "./identity-avatar-view.ts";
import "../../styles/identity-avatar.css";

const AgentAvatarFace = lazy(() => import("../agent-avatar-face.tsx"), {
  export: "AgentAvatarFace",
});

const avatarBranding = themeBrandingProjection;

export function AgentIdentityAvatar(props: {
  elementRef?: (element: HTMLElement) => void;
  agent: AgentIdentity;
  class?: string;
  onImageError?: () => void;
}) {
  const gateway = useAvatarGatewayContext();
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
          branding={avatarBranding.read()}
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
              <Errored fallback={<span class="identity-avatar__text" data-avatar="?" />}>
                <Loading>
                  <AgentAvatarFace agentId={props.agent.id} />
                </Loading>
              </Errored>
            }
          >
            <span class="identity-avatar__text" data-avatar={props.agent.textAvatar} />
          </Show>
        </span>
        <Show when={!props.agent.pending}>
          <AgentAvatarHat agentId={props.agent.id} branding={avatarBranding.read()} />
        </Show>
      </span>
    </Show>
  );
}

export function AgentOptionAvatar(props: {
  option: AgentSelectOption;
  avatar?: {
    image: string | null;
    textAvatar: string | null;
    onError?: () => void;
  };
}) {
  return (
    <Show
      when={props.avatar?.image ? undefined : props.option.icon}
      fallback={
        <AgentIdentityAvatar
          agent={{
            id: props.option.agent?.id ?? props.option.value,
            avatar: props.avatar?.image ?? null,
            textAvatar: props.avatar?.textAvatar ?? null,
          }}
          class="agent-select__avatar"
          onImageError={props.avatar?.onError}
        />
      }
    >
      {(icon) => (
        <span class="agent-select__avatar agent-select__avatar--icon" aria-hidden="true">
          <Icon name={icon()} />
        </span>
      )}
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
            {(id) => {
              const Artwork = AVATAR_HAT_ARTWORK[id];
              return <Artwork />;
            }}
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
          decoding="async"
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
