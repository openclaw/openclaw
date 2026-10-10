import { ContextProvider } from "@lit/context";
import type { JSX as SolidJSX } from "@solidjs/web";
import { html, nothing, type LitElement } from "lit";
import { applicationContext, type ApplicationContext } from "./context.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";

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
      "openclaw-link-reader-hovercard-provider": RootElementAttributes;
      "openclaw-session-progress-hovercard-provider": RootElementAttributes;
    }
  }
}

/** Temporary DOM-context bridge for unported Lit descendants; delete at cutover. */
export function connectLegacyApplicationContext(
  host: HTMLElement,
  context: ApplicationContext,
): () => void {
  const provider = new ContextProvider(host, {
    context: applicationContext,
    initialValue: context,
  });
  provider.hostConnected();
  return () => {
    provider.clearCallbacks();
    host.removeEventListener("context-request", provider.onContextRequest);
    host.removeEventListener("context-provider", provider.onProviderRequest);
  };
}

/** The unported browser document still consumes a Lit render callback. */
export function renderLegacyFocusEscape(label: string, close: () => void) {
  return isNativeWebChromeHost()
    ? nothing
    : html`<button class="btn btn--ghost" type="button" @click=${close}>${label}</button>`;
}

/** Await only the terminal island, never parked retained page updates. */
export async function settleLegacyTerminalActivation(host: HTMLElement): Promise<boolean> {
  const terminal = host.querySelector<LitElement & { available?: boolean }>(
    "openclaw-terminal-panel",
  );
  await terminal?.updateComplete;
  return terminal?.available === true;
}
