import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { ApplicationContext } from "./context.ts";

function looksLikeMcpAppLink(href: string): boolean {
  return /^(?:(?:codex|chatgpt|openclaw):\/\/plugins\/|https:\/\/chatgpt\.com\/plugins\/)[^/?#]+\/app\/[^/?#]+\/?(?:[?#]|$)/iu.test(
    href,
  );
}

export function startMcpAppRouting(context: Pick<ApplicationContext, "navigate">) {
  let disposed = false;
  const click = (event: MouseEvent) => {
    if (!shouldHandleNavigationClick(event)) {
      return;
    }
    const anchor = event
      .composedPath()
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    if (!anchor || anchor.hasAttribute("download")) {
      return;
    }
    const href = anchor.href;
    if (!looksLikeMcpAppLink(href)) {
      return;
    }
    // Chat links use target=_blank. Suppress navigation for app-shaped links even
    // when strict parsing later rejects them.
    event.preventDefault();
    void import("./mcp-app-routing.ts")
      .then(({ navigateMcpAppLink }) => {
        if (!disposed) {
          navigateMcpAppLink(context, href);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.error("[openclaw] MCP app link failed to load; click to retry", error);
        }
      });
  };
  document.addEventListener("click", click);
  return {
    dispose: () => {
      disposed = true;
      document.removeEventListener("click", click);
    },
  };
}
