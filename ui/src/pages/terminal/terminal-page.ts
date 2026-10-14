import type { RouteLocation } from "@openclaw/uirouter";
import type { JSX } from "@solidjs/web";
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

export function TerminalPage(props: { location: RouteLocation | null }): JSX.Element {
  // SAFETY: The registration above installs the Solid bridge's static renderer.
  const Bridge = customElements.get("openclaw-terminal-page") as CustomElementConstructor & {
    render: (props: { location: RouteLocation | null }) => JSX.Element;
  };
  return Bridge.render(props);
}
