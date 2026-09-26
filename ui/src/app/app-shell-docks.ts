import { html } from "lit";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "./context.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { availableLinkReaders } from "./link-reader-routing.ts";
import {
  isBrowserPanelAvailable,
  isBrowserPanelSurfaceAvailable,
  isDesktopPanelAvailable,
} from "./panel-availability.ts";
export function renderShellDocks(
  context: ApplicationContext,
  navDrawerOpen: boolean,
  suppressed: boolean,
  selectedAgentId: string,
  activeRoute: RouteId,
) {
  const gatewaySnapshot = context.gateway.snapshot;
  const gatewayConnected = gatewaySnapshot.phase === "connected";
  return html` <openclaw-browser-panel
      ?inert=${navDrawerOpen}
      data-chat-autotype-exempt
      .client=${gatewayConnected ? gatewaySnapshot.client : null}
      .available=${isBrowserPanelSurfaceAvailable(gatewaySnapshot)}
      .remoteAvailable=${isBrowserPanelAvailable(gatewaySnapshot)}
      .suppressed=${suppressed}
      .resourceBasePath=${context.resourceBasePath}
      .authToken=${resolveControlUiAuthToken({
        hello: gatewaySnapshot.hello,
        settings: { token: context.gateway.connection.token },
        password: context.gateway.connection.password,
      })}
    ></openclaw-browser-panel>
    <openclaw-desktop-panel
      ?inert=${navDrawerOpen}
      data-chat-autotype-exempt
      .client=${gatewayConnected ? gatewaySnapshot.client : null}
      .available=${isDesktopPanelAvailable(gatewaySnapshot)}
      .suppressed=${suppressed || activeRoute === "systems"}
      .basePath=${context.basePath}
    ></openclaw-desktop-panel>
    <openclaw-link-reader-panel
      ?inert=${navDrawerOpen}
      data-chat-autotype-exempt
      .client=${gatewayConnected ? gatewaySnapshot.client : null}
      .available=${gatewayConnected}
      .readers=${availableLinkReaders(gatewaySnapshot)}
      .agentId=${selectedAgentId}
      .suppressed=${suppressed}
    ></openclaw-link-reader-panel>`;
}
