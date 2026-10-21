import type { JSX as SolidJSX } from "@solidjs/web";
import type { RouteId } from "../app-routes.ts";
import type { ShellOwnedElements } from "./app-shell-lazy-view.tsx";
import type { ApplicationContext } from "./context.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { availableLinkReaders } from "./link-reader-routing.ts";
import {
  isBrowserPanelAvailable,
  isBrowserPanelSurfaceAvailable,
  isDesktopPanelAvailable,
} from "./panel-availability.ts";

type ShellDocksProps = {
  elements: Pick<ShellOwnedElements, "browserPanel" | "desktopPanel" | "linkReaderPanel">;
  context: ApplicationContext;
  revision: number;
  navDrawerOpen: boolean;
  suppressed: boolean;
  selectedAgentId: string;
  activeRoute: RouteId;
};

export function ShellDocks(props: ShellDocksProps): SolidJSX.Element {
  const gateway = () => {
    void props.revision;
    return props.context.gateway.snapshot;
  };
  const client = () => (gateway().phase === "connected" ? gateway().client : null);
  return (
    <>
      <openclaw-browser-panel
        ref={(element) => (props.elements.browserPanel = element)}
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
        ref={(element) => (props.elements.desktopPanel = element)}
        inert={props.navDrawerOpen}
        data-chat-autotype-exempt=""
        prop:client={client()}
        prop:available={isDesktopPanelAvailable(gateway())}
        prop:suppressed={props.suppressed || props.activeRoute === "systems"}
        prop:basePath={props.context.basePath}
      />
      <openclaw-link-reader-panel
        ref={(element) => (props.elements.linkReaderPanel = element)}
        inert={props.navDrawerOpen}
        data-chat-autotype-exempt=""
        prop:client={gateway().client}
        prop:available={gateway().phase === "connected"}
        prop:readers={availableLinkReaders(gateway())}
        prop:agentId={props.selectedAgentId}
        prop:suppressed={props.suppressed}
      />
    </>
  );
}
