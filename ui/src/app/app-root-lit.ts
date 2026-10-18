import type { JSX as SolidJSX } from "@solidjs/web";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";

export { connectLegacyApplicationContext } from "../lit/solid-bridge.ts";

type RootElementAttributes = SolidJSX.HTMLAttributes<HTMLElement> & {
  [key: `prop:${string}`]: unknown;
};
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tooltip-provider": RootElementAttributes;
      "openclaw-gateway-url-confirmation": RootElementAttributes;
      "openclaw-browser-document": RootElementAttributes;
      "openclaw-terminal-panel": RootElementAttributes & { fullscreen?: boolean };
      "openclaw-board-document": RootElementAttributes;
      "openclaw-login-gate": RootElementAttributes;
      "openclaw-approval-page": RootElementAttributes;
      "openclaw-question-page": RootElementAttributes;
      "openclaw-session-progress-hovercard-provider": RootElementAttributes;
    }
  }
}

/** Keep focus on the same button when the unported document rerenders its label. */
export function createLegacyFocusEscape(close: () => void): (label: string) => HTMLElement | null {
  let button: HTMLButtonElement | undefined;
  return (label) => {
    if (isNativeWebChromeHost()) {
      return null;
    }
    if (!button) {
      button = document.createElement("button");
      button.className = "btn btn--ghost";
      button.type = "button";
      button.addEventListener("click", close);
    }
    button.textContent = label;
    return button;
  };
}
