import { observeResize } from "../lib/reactive/observers.ts";
import { generateUUID } from "../lib/uuid.ts";
import type { McpAppViewElement } from "./mcp-app-view-types.ts";

export function presentMcpAppInSidebar(host: McpAppViewElement, target: HTMLElement) {
  const anchor = "--mcp-app-" + generateUUID();
  // Anchoring the existing top-layer host avoids reparenting/reloading its iframe.
  target.style.setProperty("anchor-name", anchor);
  host.style.setProperty("position-anchor", anchor);
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
    host.removeAttribute("data-sidebar-ready");
    host.displayMode = "inline";
  };
}
