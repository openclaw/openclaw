import type { McpAppIdentity } from "../../../src/shared/mcp-app-extensions.js";
import { t } from "../i18n/index.ts";
import { observeResize } from "../lib/reactive/observers.ts";
import { generateUUID } from "../lib/uuid.ts";
import { MCP_APP_OPEN_EVENT, type McpAppDisplayModeDetail } from "./mcp-app-launch.ts";
import type { McpAppViewElement } from "./mcp-app-view-types.ts";

export function presentMcpAppInSidebar(host: McpAppViewElement, target: HTMLElement) {
  const anchor = "--mcp-app-" + generateUUID();
  const styles = {
    inset: "auto",
    top: "anchor(top, -10000px)",
    left: "anchor(left, -10000px)",
    width: "anchor-size(width, 0px)",
    height: "anchor-size(height, 0px)",
    "min-height": "0",
    padding: "0",
  };
  const previous = Object.keys(styles).map(
    (key) => [key, host.style.getPropertyValue(key)] as const,
  );
  // Anchoring the existing top-layer host avoids reparenting/reloading its iframe.
  target.style.setProperty("anchor-name", anchor);
  host.style.setProperty("position-anchor", anchor);
  // This foreign-DOM presenter owns the dynamic anchor geometry and releases only its styles.
  for (const [key, value] of Object.entries(styles)) {
    host.style.setProperty(key, value);
  }
  host.style.removeProperty("visibility");
  host.setAttribute("data-sidebar-ready", "");
  host.displayMode = "fullscreen";
  // A desktop sidebar can disappear when the pane narrows or changes panels.
  // Return the same frame inline instead of leaving a detached top-layer surface.
  const stopResize = observeResize([target], (entries) => {
    if (entries.some((entry) => entry.contentRect.width === 0 || entry.contentRect.height === 0)) {
      host.displayMode = "inline";
    }
  });
  return () => {
    stopResize();
    target.style.removeProperty("anchor-name");
    if (host.style.getPropertyValue("position-anchor") !== anchor) {
      return;
    }
    host.style.removeProperty("position-anchor");
    for (const [key, value] of previous) {
      host.style.setProperty(key, value);
    }
    host.style.removeProperty("visibility");
    host.removeAttribute("data-sidebar-ready");
    host.displayMode = "inline";
  };
}

/** The containing conversation can present an expanded App beside its composer. */
export function requestMcpAppDisplayMode(
  view: McpAppViewElement,
  appIdentity?: McpAppIdentity,
): void {
  const mode = view.displayMode;
  const claimed =
    view.surface === "conversation" &&
    !view.dispatchEvent(
      new CustomEvent<McpAppDisplayModeDetail>(MCP_APP_OPEN_EVENT, {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: {
          sessionKey: view.sessionKey,
          present: ({ state, openAppPanel }) => {
            if (mode === "fullscreen") {
              state.handleOpenSidebar({
                kind: "mcp-app-preview",
                title: appIdentity?.label ?? (view.title || t("mcpApp.title")),
                view,
                appIdentity,
              });
              openAppPanel?.();
            } else if (
              state.sidebarContent?.kind === "mcp-app-preview" &&
              state.sidebarContent.view === view
            ) {
              state.handleCloseSidebar("detail");
            }
          },
        },
      }),
    );
  view.sidebar = claimed && view.displayMode === "fullscreen";
  view.style.visibility = view.sidebar && !view.hasAttribute("data-sidebar-ready") ? "hidden" : "";
}
