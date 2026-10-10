export { BrowserDocumentContent, type BrowserDocumentProps } from "./browser-document.tsx";

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-document": HTMLElement & {
      props: import("./browser-document.tsx").BrowserDocumentProps | null;
    };
  }
}
