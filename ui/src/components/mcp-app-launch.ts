import type {
  McpAppDiscoveredEntrypoint,
  McpAppExtensionTarget,
} from "../../../src/shared/mcp-app-extensions.js";
import type { ApplicationGateway } from "../app/gateway.ts";

export type McpAppDisplayModeDetail = {
  sessionKey: string;
  /** Host-created presentation command; the receiver selects its live conversation owner. */
  present: (
    owner: Pick<
      import("../pages/chat/chat-pane-mcp-app.ts").ChatPaneMcpAppOwner,
      "state" | "openAppPanel"
    >,
  ) => void;
};

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

export type McpAppOpenEventDetail = McpAppOpenDetail | McpAppDisplayModeDetail;

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
