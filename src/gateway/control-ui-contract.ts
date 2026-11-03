// Stable Control UI contract barrel for Gateway callers. Browser code imports
// narrow browser-safe modules directly so lazy route owners stay out of startup.
export * from "./control-ui-bootstrap-contract.js";
export * from "./control-ui-plugin-frame-contract.js";
export * from "./control-ui-resource-routes.js";
export * from "./control-ui-root-assets.js";
export * from "./control-ui-user-avatar-route.js";

export {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "../../packages/gateway-protocol/src/control-ui-session-pull-requests.js";

export const SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD = "controlUi.sessionPullRequests.subscribe";

/** Anonymous public-page presentation; remote URLs never cross into the renderer. */
export type ControlUiLinkPreview = {
  title?: string;
  description?: string;
  imageDataUrl?: string;
  faviconDataUrl?: string;
};

/** Bounded session metadata rendered by Control UI session-link hover cards. */
export type ControlUiSessionPreview =
  | {
      status: "ok";
      sessionKey: string;
      title?: string;
      derivedTitle?: string;
      agentId: string;
      kind?: string;
      channel?: string;
      updatedAt?: number;
      lastMessagePreview?: string;
      archived?: boolean;
    }
  | { status: "unavailable" };

export type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestCheck,
  ControlUiSessionPullRequestCheckStep,
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequests,
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequestsChanged,
} from "../../packages/gateway-protocol/src/control-ui-session-pull-requests.js";
