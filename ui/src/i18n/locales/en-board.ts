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
      boundActions: "Actions on approved targets",
      actionCapability:
        "{name}: {action}; fixed target and operation: {target}. Requires interaction with this component.",
      dataQueries: "GitHub Actions queries",
      queryCapability:
        "GitHub Actions query {name}: {selectors}; fields={fields} (uses the agent's credentials; shares selected private and future results with session readers)",
      granted: "Granted",
      allow: "Allow",
      allowFailed: "Couldn’t allow widget access. Try again.",
      reject: "Reject",
      rejectFailed: "Couldn’t reject widget access. Try again.",
      rejected: "Access rejected",
      rejectedDetail: "This widget stays inactive until it is removed or replaced.",
      appLoading: "Loading app…",
      appStaleTitle: "This pinned app is stale",
      appStaleDetail: "Its server, resource, or originating transcript is no longer available.",
      retry: "Retry",
      frameResolverMissing: "Widget content is unavailable.",
      sandboxUnavailable: "The widget sandbox is unavailable.",
      accessDenied: "You don’t have access to this widget in this session.",
      waitingForResult: "Waiting for the widget result…",
      runtimeError: "Couldn’t run this widget. Try again. {message}",
      waitingForConnection: "Disconnected. This view reconnects automatically.",
      linkFailed: "Couldn’t open this link. Try clicking it again.",
      resourceUnavailable: "Couldn’t load a widget resource. Reconnect and try again.",
      frameAuthorizationFailed: "Widget authorization failed after repeated refresh attempts.",
      sandboxOriginRequired:
        "Widget authorization failed after repeated refresh attempts. If the gateway runs behind a reverse proxy or tunnel that does not route the widget sandbox port, set mcp.apps.sandboxOrigin to a dedicated public origin routed to the sandbox listener.",
      moreInfo: "More info",
      sandboxUnreachableHint:
        "The widget sandbox didn’t respond. The gateway might run behind a reverse proxy or tunnel that doesn’t route the widget sandbox port. If so, set mcp.apps.sandboxOrigin to a dedicated public origin routed to the sandbox listener.",
      errorTitle: "Couldn’t load this widget. Try again.",
      errorDetail: "The problem is contained to this card.",
      actionErrorTitle: "Couldn’t save the widget change. Try again.",
      actionErrorDetail: "The dashboard kept the previous widget state.",
      errorShow: "Show details",
    },
  },
} satisfies TranslationMap;

export const registerBoardEnglish = Object.assign(
  () => Object.assign(en.board.widget, enBoard.board.widget),
  { catalog: enBoard },
);
