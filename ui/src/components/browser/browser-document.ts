import { createComponent } from "solid-js";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { BrowserDocumentContent, type BrowserDocumentProps } from "./browser-document.tsx";

export { BrowserDocumentContent, type BrowserDocumentProps } from "./browser-document.tsx";

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
      });
    },
    { properties: { props: { default: null, attribute: false } } },
  );
}
