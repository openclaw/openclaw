import { createEffect, onCleanup } from "@solidjs/signals";
import { nothing, render, type TemplateResult } from "lit";
import { createComponent } from "solid-js";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { renderConnectingSplash } from "../loading-skeleton.ts";
import { BrowserDocumentContent, type BrowserDocumentViewProps } from "./browser-document.tsx";

export { BrowserDocumentContent } from "./browser-document.tsx";

export type BrowserDocumentProps = Omit<BrowserDocumentViewProps, "renderEscape"> & {
  renderEscape: (label: string) => TemplateResult | typeof nothing;
};

// The unported app shell owns these template ranges until its rendering cutover.
function renderTemplate(read: () => unknown): HTMLElement {
  const host = document.createElement("span");
  host.style.display = "contents";
  createEffect(read, (template) => {
    render(template, host);
  });
  onCleanup(() => render(nothing, host));
  return host;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-document": HTMLElement & {
      props: BrowserDocumentProps | null;
    };
  }
}

if (!customElements.get("openclaw-browser-document")) {
  defineSolidBridge<{ props: BrowserDocumentProps | null }>(
    "openclaw-browser-document",
    (props, host) => {
      host.style.display = "contents";
      return createComponent(BrowserDocumentContent, {
        get value() {
          return props.props;
        },
        renderTemplate,
        renderConnecting: renderConnectingSplash,
      });
    },
    { properties: { props: { default: null, attribute: false } } },
  );
}
