import {
  canCallGatewayMethod,
  canPresentGatewayMethod,
  isGatewayMethodAdvertised,
} from "../lib/gateway-methods.ts";
import type { ApplicationContext } from "./context.ts";
import { hasNativeBrowserBridge } from "./native-browser-host.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

type GatewaySnapshot = Pick<ApplicationContext["gateway"]["snapshot"], "phase" | "hello">;

export type PanelUnavailableReason = "disconnected" | "permission" | "unavailable";

function panelUnavailableReason(
  snapshot: GatewaySnapshot,
  method: string,
): PanelUnavailableReason | null {
  if (snapshot.phase !== "connected") {
    return "disconnected";
  }
  if (!hasOperatorAdminAccess(snapshot.hello?.auth ?? null)) {
    return "permission";
  }
  return isGatewayMethodAdvertised(snapshot, method) === true ? null : "unavailable";
}

export function isBrowserPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return panelUnavailableReason(snapshot, "browser.request") === null;
}

/** The session owner checks target membership, tool policy, and sandbox requirements. */
export function isBrowserDashboardAvailable(
  snapshot: Pick<ApplicationContext["gateway"]["snapshot"], "client" | "phase" | "hello">,
): boolean {
  return (
    isBrowserPanelAvailable(snapshot) ||
    canCallGatewayMethod(snapshot, "browser.dashboard.request", "operator.sessions.write")
  );
}

export function browserPanelSurfaceUnavailableReason(
  snapshot: GatewaySnapshot,
): PanelUnavailableReason | null {
  return hasNativeBrowserBridge() ? null : panelUnavailableReason(snapshot, "browser.request");
}

export function isBrowserPanelSurfaceAvailable(snapshot: GatewaySnapshot): boolean {
  return browserPanelSurfaceUnavailableReason(snapshot) === null;
}

export function isDesktopPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return panelUnavailableReason(snapshot, "desktop.observe") === null;
}

/** Admin-only, never advertisement alone; the Custodian session store authorizes each turn. */
export function isCustodianPanelAvailable(
  gateway: ApplicationContext["gateway"] | undefined,
): boolean {
  return canPresentGatewayMethod(gateway?.snapshot, "openclaw.chat", "operator.admin");
}

/** Presentation access survives reconnect; the chat send/outbox owner still authorizes delivery. */
export function isHomePanelAvailable(gateway: ApplicationContext["gateway"] | undefined): boolean {
  return (
    canPresentGatewayMethod(gateway?.snapshot, "chat.history", "operator.read") &&
    canPresentGatewayMethod(gateway?.snapshot, "chat.send", "operator.write")
  );
}
