import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { AuthenticatedAvatarRouteLoader } from "../../lib/authenticated-avatar-route.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";

export type ChannelAvatarProps = {
  routeUrl?: string | null;
  authTokens?: readonly string[];
  authReady?: boolean;
};

/** Channel conversation image loaded from the Gateway's authenticated proxy route. */
export function ChannelAvatarContent(props: ChannelAvatarProps & { children?: JSX.Element }) {
  const [revision, invalidate] = createSignal(0, { ownedWrite: true });
  const [undecodableRouteUrl, setUndecodableRouteUrl] = createSignal<string | null>(null);
  const loader = new AuthenticatedAvatarRouteLoader(() => invalidate((value) => value + 1));
  loader.connect();
  onCleanup(() => loader.disconnect());
  const blobUrl = createMemo(() => {
    revision();
    const routeUrl = props.routeUrl;
    const authTokens = props.authTokens ?? [];
    const available = props.authReady && undecodableRouteUrl() !== routeUrl;
    return loader.withActiveRoutes(() =>
      routeUrl && available ? loader.resolve(routeUrl, authTokens) : null,
    );
  });

  return (
    <>
      <span style={{ display: blobUrl() ? "none" : "contents" }}>{props.children}</span>
      <Show when={blobUrl()}>
        {(url) => (
          <img
            class="channel-avatar"
            src={url()}
            alt=""
            aria-hidden="true"
            decoding="async"
            onError={() => setUndecodableRouteUrl(props.routeUrl ?? null)}
          />
        )}
      </Show>
    </>
  );
}

export type ChannelAvatarElement = SolidBridgeElement<ChannelAvatarProps>;
export const ChannelAvatar = defineSolidBridge<ChannelAvatarProps>(
  "openclaw-channel-avatar",
  (props, host) => {
    host.style.display = "contents";
    return <ChannelAvatarContent {...props} />;
  },
  {
    properties: {
      routeUrl: { default: null, attribute: false },
      authTokens: { default: [], attribute: false },
      authReady: { default: false, attribute: false },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-channel-avatar": ChannelAvatarElement;
  }
}
