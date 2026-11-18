import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { ShellNavigationCapability } from "./app-shell-navigation.ts";
import type { ApplicationContext } from "./context.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";

export interface ShellNewSessionHost extends Pick<HTMLElement, "isConnected"> {
  routeOutlet?: ControlUiReadinessOutlet;
  readonly context: ApplicationContext | undefined;
  readonly onboardingMode: boolean;
  navDrawerElement?: HTMLElement;
  pendingNativeNewSession: boolean;
  readonly shellNavigation: Pick<ShellNavigationCapability, "openNewSession">;
}

/** Native startup may queue navigation; a keyboard action belongs to the ready surface only. */
export function openShellNewSession(
  host: ShellNewSessionHost,
  source: "native" | "shortcut",
): boolean {
  const context = host.context;
  if (
    host.onboardingMode ||
    (source === "shortcut" &&
      (document.openClawModalLayers?.size ||
        host.navDrawerElement?.getAttribute("aria-modal") === "true"))
  ) {
    return false;
  }
  if (!context) {
    if (source === "native") {
      host.pendingNativeNewSession = true;
      return true;
    }
    return false;
  }
  if (
    !readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.create",
      params: {},
      sessionScope: true,
    }).allowed
  ) {
    return false;
  }
  host.shellNavigation.openNewSession(context.agentSelection.state.selectedId ?? "");
  if (source === "shortcut") {
    host.routeOutlet?.renderedElement?.("openclaw-new-session-page")?.focusComposer();
  }
  return true;
}
