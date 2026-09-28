import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ApprovalRouteReport,
  ApprovalRouteSkipReason,
  GatewayRequestFn,
  RouteNoticeTarget,
} from "./approval-native-route-notice.js";
import type {
  ApprovalRequestChannelRouteClass,
  ApprovalRequestInput as ApprovalRequest,
  ChannelApprovalKind,
} from "./approval-types.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

export type ApprovalRouteRuntimeRecord = {
  runtimeId: string;
  handledKinds: ReadonlySet<ChannelApprovalKind>;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  sourceConfig?: OpenClawConfig;
  isOriginCurrent?: (request: ApprovalRequest, handoffConfig?: OpenClawConfig) => boolean;
  requestGateway: GatewayRequestFn;
  shouldHandle: (request: ApprovalRequest) => boolean;
  classifyRoute: (request: ApprovalRequest) => ApprovalRequestChannelRouteClass;
};

export type PendingApprovalRouteNotice = {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  reports: Map<string, ApprovalRouteReport>;
  cleanupTimeout: NodeJS.Timeout;
};

export type ApprovalRouteSelectionVerdict =
  | { kind: "selected" }
  | { kind: ApprovalRouteSkipReason }
  | { kind: "selector-error"; error: unknown };

export type ApprovalRouteSelection = {
  verdicts: Map<string, ApprovalRouteSelectionVerdict>;
  pluginTerminalStatus?: PluginTerminalStatus;
  cleanupTimeout: NodeJS.Timeout;
};

export type PluginTerminalStatus = "allowed" | "denied" | "expired" | "cancelled";

export type PluginTerminalNotice = {
  request: ApprovalRequest;
  requestGateway?: GatewayRequestFn;
  target?: RouteNoticeTarget;
  isOriginCurrent?: (cfg?: OpenClawConfig) => boolean;
  initialNotice?: Promise<void>;
  status?: "denied" | "expired";
  sent: boolean;
  sending?: Promise<void>;
  cleanupTimeout: NodeJS.Timeout;
};

export type PluginOriginBinding = {
  request: PluginApprovalRequest;
  runtime?: ApprovalRouteRuntimeRecord;
  requestGateway: GatewayRequestFn;
  isOriginCurrent: (cfg?: OpenClawConfig) => boolean;
  target: RouteNoticeTarget;
  releaseApprovalBinding?: () => void;
  terminalStatus?: PluginTerminalStatus;
  localRoute: "pending" | "selected" | "none";
  originDelivered?: boolean;
  cleanupTimeout: NodeJS.Timeout;
};

export type ApprovalNativeRouteCoordinatorState = {
  activeRuntimes: Map<string, ApprovalRouteRuntimeRecord>;
  pendingNotices: Map<string, PendingApprovalRouteNotice>;
  pluginTerminalNotices: Map<string, PluginTerminalNotice>;
  selections: Map<string, ApprovalRouteSelection>;
  pluginOrigins: Map<string, PluginOriginBinding>;
  runtimeSeq: number;
  closed: boolean;
};
