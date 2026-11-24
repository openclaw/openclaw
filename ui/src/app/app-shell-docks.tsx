import type { JSX as SolidJSX } from "@solidjs/web";
import { lazy } from "solid-js";
import type { RouteId } from "../app-routes.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ShellRequestedComponent } from "./app-shell-component-boundary.tsx";
import type { ShellComponentHost, ShellOwnedElements } from "./app-shell-components.ts";
import type { ApplicationContext } from "./context.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { availableLinkReaders } from "./link-reader-routing.ts";
import {
  isBrowserPanelAvailable,
  isBrowserPanelSurfaceAvailable,
  isDesktopPanelAvailable,
} from "./panel-availability.ts";

const BrowserPanel = lazy(() => import("../components/browser/browser-panel.ts"), {
  export: "BrowserPanelHost",
});
const DesktopPanel = lazy(() => import("../components/desktop/desktop-panel-solid.tsx"), {
  export: "DesktopPanel",
});
const LinkReaderPanel = lazy(() => import("../components/link-reader-panel.tsx"), {
  export: "LinkReaderPanel",
});

type ShellDocksProps = {
  host: ShellComponentHost;
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
      <ShellRequestedComponent
        host={props.host}
        component="browser"
        revision={props.revision}
        label="browser panel"
      >
        <BrowserPanel
          ref={(element) => {
            props.elements.browserPanel = element;
            props.host.shellComponentMounted(element);
          }}
          inert={props.navDrawerOpen}
          data-chat-autotype-exempt=""
          client={client()}
          available={isBrowserPanelSurfaceAvailable(gateway())}
          remoteAvailable={isBrowserPanelAvailable(gateway())}
          suppressed={props.suppressed}
          resourceBasePath={props.context.resourceBasePath}
          authToken={resolveControlUiAuthToken({
            hello: gateway().hello,
            settings: { token: props.context.gateway.connection.token },
            password: props.context.gateway.connection.password,
          })}
        />
      </ShellRequestedComponent>
      <ShellRequestedComponent
        host={props.host}
        component="desktop"
        revision={props.revision}
        label="desktop panel"
      >
        <DesktopPanel
          ref={(element) => {
            props.elements.desktopPanel = element;
            props.host.shellComponentMounted(element);
          }}
          inert={props.navDrawerOpen}
          data-chat-autotype-exempt=""
          client={client()}
          available={isDesktopPanelAvailable(gateway())}
          suppressed={props.suppressed || props.activeRoute === "systems"}
          basePath={props.context.basePath}
        />
      </ShellRequestedComponent>
      <ShellRequestedComponent
        host={props.host}
        component="link-reader"
        revision={props.revision}
        label={t("linkReader.title")}
      >
        <LinkReaderPanel
          ref={(element) => {
            props.elements.linkReaderPanel = element;
            props.host.shellComponentMounted(element);
          }}
          inert={props.navDrawerOpen}
          data-chat-autotype-exempt=""
          client={gateway().client}
          available={gateway().phase === "connected"}
          readers={availableLinkReaders(gateway())}
          agentId={props.selectedAgentId}
          suppressed={props.suppressed}
        />
      </ShellRequestedComponent>
    </>
  );
}
