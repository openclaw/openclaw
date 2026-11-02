import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enBoard = {
  board: {
    widget: {
      needsApproval: "Needs approval",
      needsApprovalDetail: "This widget requested additional access.",
      networkAccess: "Network origins",
      hostTools: "Host tools and data",
      activeCapabilities: "Active widget capabilities",
      networkCapability: "Network: {capability}",
      toolCapability: "Tool: {capability}",
      granted: "Granted",
      allow: "Allow",
      allowFailed: "Could not allow widget access. Try again.",
      reject: "Reject",
      rejectFailed: "Could not reject widget access. Try again.",
      rejected: "Access rejected",
      rejectedDetail: "This widget stays inactive until it is removed or replaced.",
      appLoading: "Restoring app…",
      appStaleTitle: "This pinned app is stale",
      appStaleDetail: "Its server, resource, or originating transcript is no longer available.",
      retry: "Retry",
      frameResolverMissing: "Widget content is unavailable.",
      sandboxUnavailable: "Widget sandbox host is unavailable.",
      accessDenied: "You don’t have access to this widget in this conversation.",
      waitingForResult: "Waiting for the widget result.",
      runtimeError: "Script error: {message}",
      waitingForConnection: "Waiting for the connection. This view will recover automatically.",
      resourceUnavailable:
        "A widget resource could not load. Retry when the connection is available.",
      frameAuthorizationFailed: "Widget authorization failed after repeated refresh attempts.",
      sandboxOriginRequired:
        "Widget authorization failed after repeated refresh attempts. If the gateway runs behind a reverse proxy or tunnel that does not route the widget sandbox port, set mcp.apps.sandboxOrigin to a dedicated public origin routed to the sandbox listener.",
      errorTitle: "This widget could not load",
      errorDetail: "The problem is contained to this card.",
      actionErrorTitle: "Widget change failed",
      actionErrorDetail: "The dashboard kept the previous widget state.",
      errorShow: "Show details",
    },
  },
} satisfies TranslationMap;

export const registerBoardEnglish = Object.assign(
  () => Object.assign(en.board.widget, enBoard.board.widget),
  { catalog: enBoard },
);
