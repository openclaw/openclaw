import type {
  McpAppDiscoveredEntrypoint,
  McpAppExtensionTarget,
} from "../../../src/shared/mcp-app-extensions.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import type { McpAppViewElement } from "./mcp-app-view-types.ts";

export const MCP_APP_DISPLAY_MODE_EVENT = "openclaw-mcp-app-display-mode";
export type McpAppDisplayModeDetail = {
  sessionKey: string;
  mode: "inline" | "fullscreen";
  view: McpAppViewElement;
};

/** The containing conversation can present an expanded App beside its composer. */
export function requestMcpAppDisplayMode(view: McpAppViewElement): boolean {
  return (
    view.surface === "conversation" &&
    !view.dispatchEvent(
      new CustomEvent<McpAppDisplayModeDetail>(MCP_APP_DISPLAY_MODE_EVENT, {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: { sessionKey: view.sessionKey, mode: view.displayMode, view },
      }),
    )
  );
}

/** The synchronous workspace owner retires presentation without cancelling admitted writes. */
export type McpAppPanelRetirement = (retire: () => void) => () => void;

export const MCP_APP_OPEN_EVENT = "openclaw-mcp-app-open";
export type McpAppOpenDetail = McpAppExtensionTarget & {
  owner: ApplicationGateway["snapshot"]["client"];
  serverName: string;
  entrypoint: McpAppDiscoveredEntrypoint;
  deepLink?: string;
  filePath?: string;
  settings?: boolean;
  quickAction?: boolean;
};

/** The containing conversation accepts synchronously before any remote tool runs. */
export function requestMcpAppOpen(element: HTMLElement, detail: McpAppOpenDetail): boolean {
  return !element.dispatchEvent(
    new CustomEvent<McpAppOpenDetail>(MCP_APP_OPEN_EVENT, {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}
