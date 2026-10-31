import type { ApprovalScope } from "./approval-scope.js";
import type { ApprovalRequestInput, ChannelApprovalKind } from "./approval-types.js";
import type { CommandExplanationSummary } from "./command-analysis/explain.js";
import type { ExecApprovalActionDescriptor } from "./exec-approval-action.types.js";
import type { ExecApprovalDecision, ExecApprovalResolved } from "./exec-approvals-core.js";
import type { PluginApprovalResolved } from "./plugin-approvals.js";
import type {
  SystemAgentApprovalApplicationStatus,
  SystemAgentApprovalResolved,
} from "./system-agent-approvals.js";

export type ApprovalActionView = ExecApprovalActionDescriptor & {
  kind?: "command" | "decision";
};

export type ApprovalMetadataView = {
  label: string;
  value: string;
};

type ApprovalViewBase = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  phase: "pending" | "resolved" | "expired";
  title: string;
  description?: string | null;
  metadata: ApprovalMetadataView[];
};

export type ExecApprovalViewBase = ApprovalViewBase & {
  approvalKind: "exec";
  ask?: string | null;
  agentId?: string | null;
  warningText?: string | null;
  commandAnalysis?: CommandExplanationSummary | null;
  commandText: string;
  commandPreview?: string | null;
  cwd?: string | null;
  envKeys?: readonly string[];
  host?: string | null;
  nodeId?: string | null;
  scope?: ApprovalScope | null;
  sessionKey?: string | null;
};

type PendingApprovalState = {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

type ResolvedApprovalState = {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

export type ExecApprovalPendingView = ExecApprovalViewBase & PendingApprovalState;

export type ExecApprovalResolvedView = ExecApprovalViewBase & ResolvedApprovalState;

export type ExecApprovalExpiredView = ExecApprovalViewBase & {
  phase: "expired";
};

export type PluginApprovalViewBase = ApprovalViewBase & {
  approvalKind: "plugin";
  agentId?: string | null;
  pluginId?: string | null;
  scope?: ApprovalScope | null;
  toolName?: string | null;
  severity: "info" | "warning" | "critical";
};

export type PluginApprovalPendingView = PluginApprovalViewBase & PendingApprovalState;

export type PluginApprovalResolvedView = PluginApprovalViewBase & ResolvedApprovalState;

export type PluginApprovalExpiredView = PluginApprovalViewBase & {
  phase: "expired";
};

export type SystemAgentApprovalViewBase = ApprovalViewBase & {
  approvalKind: "system-agent";
  agentId?: string | null;
  scope?: null;
  commandText: string;
  commandPreview?: string | null;
  ask?: string | null;
  cwd?: string | null;
  envKeys?: readonly string[];
  host?: string | null;
  nodeId?: string | null;
  sessionKey?: string | null;
  operationSummary: string;
};

export type PendingApprovalView =
  | ExecApprovalPendingView
  | PluginApprovalPendingView
  | (SystemAgentApprovalViewBase & PendingApprovalState);
export type ResolvedApprovalView =
  | ExecApprovalResolvedView
  | PluginApprovalResolvedView
  | (SystemAgentApprovalViewBase &
      ResolvedApprovalState & {
        applicationStatus?: SystemAgentApprovalApplicationStatus;
        terminalStatus?: "expired" | "cancelled";
      });
export type ExpiredApprovalView =
  | ExecApprovalExpiredView
  | PluginApprovalExpiredView
  | (SystemAgentApprovalViewBase & {
      phase: "expired";
    });
export type ApprovalViewModel = PendingApprovalView | ResolvedApprovalView | ExpiredApprovalView;

export type ApprovalRequest = ApprovalRequestInput;
export type ApprovalResolved =
  | (ExecApprovalResolved & { applicationStatus?: never; terminalStatus?: never })
  | (PluginApprovalResolved & { applicationStatus?: never; terminalStatus?: never })
  | SystemAgentApprovalResolved;
