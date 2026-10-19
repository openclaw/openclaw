import {
  canCallGatewayMethod,
  canPresentGatewayMethod,
  isGatewayMethodAdvertised,
} from "../lib/gateway-methods.ts";
import type { ApplicationContext } from "./context.ts";
import { hasNativeBrowserBridge } from "./native-browser-host.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

type GatewaySnapshot = Pick<ApplicationContext["gateway"]["snapshot"], "phase" | "hello">;

function isPanelAvailable(snapshot: GatewaySnapshot, method: string): boolean {
  return (
    snapshot.phase === "connected" &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, method) === true
  );
}

export function isBrowserPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return isPanelAvailable(snapshot, "browser.request");
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

export function isBrowserPanelSurfaceAvailable(snapshot: GatewaySnapshot): boolean {
  return hasNativeBrowserBridge() || isBrowserPanelAvailable(snapshot);
}

export function isDesktopPanelAvailable(snapshot: GatewaySnapshot): boolean {
  return isPanelAvailable(snapshot, "desktop.observe");
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
