import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { TerminalPageContent } from "./terminal-page.tsx";

if (!customElements.get("openclaw-terminal-page")) {
  defineSolidBridge<{ location: RouteLocation | null }>(
    "openclaw-terminal-page",
    (props) => createComponent(TerminalPageContent, props),
    { properties: { location: { default: null, attribute: false } } },
  );
}
