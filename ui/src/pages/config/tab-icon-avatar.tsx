import { createMemo, Show } from "solid-js";
import type { AgentTabIconShape } from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import { avatarArtwork } from "../../components/identity-avatar-view.ts";
import {
  IdentityAvatarImage,
  identityAvatarState,
} from "../../components/solid/identity-avatar-image.tsx";
import { renderThemeBrandIcon } from "../../components/theme-brand-icon.ts";
import { projectSource } from "../../lib/reactive/projection.ts";

function FallbackArtwork(props: { fallbackUrl: string }) {
  const branding = projectSource(null, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  return (
    <Show
      when={branding.read().brandIcon === "claw" || branding.read().brandIcon === "mark"}
      fallback={
        <span
          ref={avatarArtwork(() => renderThemeBrandIcon(undefined, branding.read()))}
          style={{ display: "contents" }}
        />
      }
    >
      <img src={props.fallbackUrl} alt="" />
    </Show>
  );
}

export function TabIconAvatar(props: {
  imageUrl: string | null;
  shape?: AgentTabIconShape;
  fallbackUrl: string;
  fallbackOnly?: boolean;
}) {
  const view = createMemo(() => ({ imageUrl: props.imageUrl, pending: false }));
  return (
    <Show when={!props.fallbackOnly} fallback={<FallbackArtwork fallbackUrl={props.fallbackUrl} />}>
      <span
        ref={identityAvatarState(view)}
        class="identity-avatar--agent settings-tab-icon__preview"
        data-avatar-shape={props.shape ?? "square"}
        aria-hidden="true"
      >
        <Show when={Boolean(view().imageUrl)}>
          <IdentityAvatarImage
            view={view()}
            fallbackSelector=".settings-tab-icon__preview"
            class="identity-avatar__image"
          />
        </Show>
        <span class="identity-avatar__fallback">
          <FallbackArtwork fallbackUrl={props.fallbackUrl} />
        </span>
      </span>
    </Show>
  );
}
