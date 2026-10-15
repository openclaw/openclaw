import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type { RouteId } from "../app-routes.ts";
import type { ShellElementAttributes } from "./app-shell-lazy-view.tsx";
import type { ApplicationContext } from "./context.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { availableLinkReaders } from "./link-reader-routing.ts";
import {
  isBrowserPanelAvailable,
  isBrowserPanelSurfaceAvailable,
  isDesktopPanelAvailable,
} from "./panel-availability.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-browser-panel": ShellElementAttributes;
      "openclaw-link-reader-panel": ShellElementAttributes;
    }
  }
}

type ShellDocksProps = {
  context: ApplicationContext;
  revision: number;
  navDrawerOpen: boolean;
  suppressed: boolean;
  selectedAgentId: string;
  activeRoute: RouteId;
};

export function ShellDocks(props: ShellDocksProps): SolidJSX.Element {
  const snapshot = createMemo(() => ({
    revision: props.revision,
    value: props.context.gateway.snapshot,
  }));
  const gateway = () => snapshot().value;
  const client = () => (gateway().phase === "connected" ? gateway().client : null);
  return (
    <>
      <openclaw-browser-panel
        inert={props.navDrawerOpen}
        data-chat-autotype-exempt=""
        prop:client={client()}
        prop:available={isBrowserPanelSurfaceAvailable(gateway())}
        prop:remoteAvailable={isBrowserPanelAvailable(gateway())}
        prop:suppressed={props.suppressed}
        prop:resourceBasePath={props.context.resourceBasePath}
        prop:authToken={resolveControlUiAuthToken({
          hello: gateway().hello,
          settings: { token: props.context.gateway.connection.token },
          password: props.context.gateway.connection.password,
        })}
      />
      <openclaw-desktop-panel
        inert={props.navDrawerOpen}
        data-chat-autotype-exempt=""
        prop:client={client()}
        prop:available={isDesktopPanelAvailable(gateway())}
        prop:suppressed={props.suppressed || props.activeRoute === "systems"}
        prop:basePath={props.context.basePath}
      />
      <openclaw-link-reader-panel
        inert={props.navDrawerOpen}
        data-chat-autotype-exempt=""
        prop:client={client()}
        prop:available={gateway().phase === "connected"}
        prop:readers={availableLinkReaders(gateway())}
        prop:agentId={props.selectedAgentId}
        prop:suppressed={props.suppressed}
      />
    </>
  );
}
