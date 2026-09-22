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
    promptShow: "Show me in a portal.",
    promptStart: "Start the application in a portal.",
    promptMakeAvailable: "Make the server available in a portal.",
    unsupported: "This gateway does not support portals.",
    loadFailed: "Could not load portals: {error}",
    closeFailed: "Could not close the portal: {error}",
    unreachableTitle: "Portal not reachable from this browser",
    unreachableBody:
      "The Gateway is likely being accessed through a proxy or tunnel that exposes only its main port. Open this URL from a browser on the Gateway host.",
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
