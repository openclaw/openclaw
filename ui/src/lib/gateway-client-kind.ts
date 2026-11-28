import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";

/** Presentation describes the reported client, never the person or its authority. */
export function gatewayClientKind(client: { id?: string | null; mode?: string | null }) {
  if (client.id === GATEWAY_CLIENT_IDS.TUI) {
    return "terminal";
  }
  if (
    client.mode === "webchat" ||
    client.id === GATEWAY_CLIENT_IDS.CONTROL_UI ||
    client.id === GATEWAY_CLIENT_IDS.BROWSER_COPILOT ||
    client.id === GATEWAY_CLIENT_IDS.WEBCHAT_UI ||
    client.id === GATEWAY_CLIENT_IDS.WEBCHAT
  ) {
    return "web";
  }
  if (client.id === GATEWAY_CLIENT_IDS.CLI || client.mode === "cli") {
    return "cli";
  }
  if (
    client.mode === "ui" ||
    client.id === GATEWAY_CLIENT_IDS.MACOS_APP ||
    client.id === GATEWAY_CLIENT_IDS.LINUX_APP ||
    client.id === GATEWAY_CLIENT_IDS.IOS_APP ||
    client.id === GATEWAY_CLIENT_IDS.WATCHOS_APP ||
    client.id === GATEWAY_CLIENT_IDS.ANDROID_APP
  ) {
    return "app";
  }
  return undefined;
}
