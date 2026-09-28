import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayNativeApprovalMethod } from "./approval-gateway-runtime-methods.js";
import type { ApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import type { ApprovalRouteSendParams } from "./approval-native-route-notice.js";
import type { ApprovalRequest, ChannelApprovalKind } from "./approval-types.js";
import type { ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalResolved } from "./plugin-approvals.js";
import type { SystemAgentApprovalResolved } from "./system-agent-approvals.js";

export type GatewayApprovalRequest = ApprovalRequest;
export type GatewayApprovalResolved =
  | ExecApprovalResolved
  | PluginApprovalResolved
  | SystemAgentApprovalResolved;

export type GatewayApprovalEventSubscriber = {
  eventKinds: ReadonlySet<ChannelApprovalKind>;
  channel?: string;
  accountId?: string | null;
  shouldHandle: (request: GatewayApprovalRequest) => boolean;
  onRequested: (request: GatewayApprovalRequest) => void;
  onResolved: (resolved: GatewayApprovalResolved) => void;
};

/** Gateway-owned authority and event transport for channel-native approval runtimes. */
export type GatewayNativeApprovalRuntime = {
  request: <T = unknown>(
    method: GatewayNativeApprovalMethod,
    params: Record<string, unknown>,
    options?: { clientDisplayName?: string },
  ) => Promise<T>;
  requestRoute: (
    method: "send",
    params: ApprovalRouteSendParams,
    options?: { liveOnlyWhenCurrent: (cfg?: OpenClawConfig) => boolean },
  ) => Promise<void>;
  routeCoordinator: ApprovalNativeRouteCoordinator;
  subscribe: (subscriber: GatewayApprovalEventSubscriber) => () => void;
};
