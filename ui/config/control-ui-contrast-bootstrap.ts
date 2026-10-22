import type { Plugin } from "vite";
import { resolveContrast } from "../src/app/contrast.ts";

/** Share the exact live resolver with the synchronous, CSP-hashed first-paint script. */
export function inlineContrastResolver(html: string): string {
  return html.replace("__OPENCLAW_RESOLVE_CONTRAST__", () => resolveContrast.toString());
}

export function controlUiContrastBootstrapPlugin(): Plugin {
  return {
    name: "control-ui-contrast-bootstrap",
    transformIndexHtml: { order: "pre", handler: inlineContrastResolver },
  };
}
