import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { AuthenticatedAvatarRouteLoader } from "../lib/authenticated-avatar-route.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";

type WorkspaceIconProps = {
  routeUrl: string | null;
  authTokens: readonly string[];
  authReady: boolean;
  connectionId: string | undefined;
};

export type WorkspaceIconElement = SolidBridgeElement<WorkspaceIconProps>;
export const WorkspaceIcon = defineSolidBridge<WorkspaceIconProps>(
  "openclaw-workspace-icon",
  (props, host) => {
    host.style.display = "contents";
    const [revision, refresh] = createSignal(0, { ownedWrite: true });
    const [undecodableRouteUrl, setUndecodableRouteUrl] = createSignal<string | null>(null);
    const loader = new AuthenticatedAvatarRouteLoader(() => refresh((value) => value + 1), {
      retryUnavailable: true,
    });
    loader.connect();
    onCleanup(() => loader.disconnect());
    const blobUrl = createMemo(() => {
      revision();
      return loader.withActiveRoutes(() =>
        props.routeUrl && props.authReady && undecodableRouteUrl() !== props.routeUrl
          ? loader.resolve(props.routeUrl, props.authTokens, props.connectionId)
          : null,
      );
    });
    return (
      <Show
        when={blobUrl()}
        fallback={
          <span class="workspace-icon-fallback" aria-hidden="true">
            <Icon name="folder" />
          </span>
        }
      >
        <img
          class="workspace-icon"
          src={blobUrl() ?? undefined}
          alt=""
          aria-hidden="true"
          decoding="async"
          onError={() => setUndecodableRouteUrl(props.routeUrl)}
        />
      </Show>
    );
  },
  {
    properties: {
      routeUrl: { default: null, attribute: false },
      authTokens: { default: [], attribute: false },
      authReady: { default: false, attribute: false },
      connectionId: { default: undefined, attribute: false },
    },
  },
);
