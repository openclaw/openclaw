import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enPortals = {
  portalsPage: {
    listLabel: "Active portals",
    portLabel: "Port {port}",
    openNewTab: "Open in new tab",
    closePortal: "Close {title}",
    previewTitle: "{title} portal preview",
    loading: "Loading portals…",
    emptyHint: "Ask the agent to start a portal:",
    unavailable: "This portal is no longer available. Ask the agent to reopen the application.",
    environmentStarting: "Starting your machine…",
    waitingForApp: "Machine ready. Waiting for your application…",
    environmentUnavailable: "The machine could not start. Ask the agent to check it or try again.",
    promptShow: "Show me in a portal.",
    promptStart: "Start the application in a portal.",
    promptMakeAvailable: "Make the server available in a portal.",
    unsupported: "This gateway does not support portals.",
    loadFailed: "Could not load portals: {error}",
    closeFailed: "Could not close the portal: {error}",
    unreachableTitle: "Portal not reachable from this browser",
    unreachableBody:
      "Check the portal URL's DNS, TLS, and network access. For private Tailscale Serve, allow its HTTPS port in your tailnet policy. For a reverse proxy, check the dedicated portal ingress route, then retry.",
    newTabRequiredTitle: "Open this HTTP portal in a new tab",
    newTabRequiredBody:
      "This portal uses HTTP with a different hostname or scheme from the Control UI. Open the link in a new tab so its authentication cookies work, or use an HTTPS portal for an embedded preview.",
    ingressRequiredTitle: "Remote portal ingress required",
    ingressRequiredBody:
      "This Gateway returned a loopback URL, which points to this browser's machine. Use a browser on the Gateway host, enable managed private Tailscale Serve, or configure gateway.portals.ingress with a separate private HTTPS wildcard proxy. Forwarding only the Gateway port is not enough.",
    writeAccessRequiredTitle: "Write access required",
    writeAccessRequiredBody: "This portal requires an operator with write access.",
    retry: "Retry",
  },
} satisfies TranslationMap;

export const registerPortalsEnglish = Object.assign(
  () => {
    en.portalsPage = enPortals.portalsPage;
  },
  { catalog: enPortals },
);
