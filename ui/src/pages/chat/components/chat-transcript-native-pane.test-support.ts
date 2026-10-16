import { html } from "lit";
import type { Component } from "solid-js";
import { solidContent } from "../../../lit/solid-content.tsx";

/** ChatPaneRuntime still requires a Lit layout; its geometry fixture renders natively inside it. */
export function nativePaneLayout<P extends Record<string, unknown>>(
  component: Component<P>,
  props: P,
) {
  return html`${solidContent(component, props)}`;
}
