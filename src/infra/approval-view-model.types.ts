import type { InteractiveReplyButton } from "../interactive/payload.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type { CommandExplanationSummary } from "./command-analysis/explain.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

type ApprovalPhase = "pending" | "resolved" | "expired";

/** Button/action shape shared by channel renderers for approval decisions. */
export type ApprovalActionView = {
  kind?: "command" | "decision";
  decision: ExecApprovalDecision;
  label: string;
  style: NonNullable<InteractiveReplyButton["style"]>;
  command: string;
};

/** Label/value metadata row shown with approval views. */
export type ApprovalMetadataView = {
  label: string;
  value: string;
};

type ApprovalViewBase = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  phase: ApprovalPhase;
  title: string;
  description?: string | null;
  metadata: ApprovalMetadataView[];
};

/** Shared exec approval fields used by pending/resolved/expired renderers. */
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
  sessionKey?: string | null;
};

/** Pending exec approval view including available decision actions. */
export type ExecApprovalPendingView = ExecApprovalViewBase & {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

/** Resolved exec approval view after an operator decision. */
export type ExecApprovalResolvedView = ExecApprovalViewBase & {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

/** Expired exec approval view after the approval window closes. */
export type ExecApprovalExpiredView = ExecApprovalViewBase & {
  phase: "expired";
};

/** Shared plugin approval fields used by pending/resolved/expired renderers. */
export type PluginApprovalViewBase = ApprovalViewBase & {
  approvalKind: "plugin";
  agentId?: string | null;
  pluginId?: string | null;
  toolName?: string | null;
  severity: "info" | "warning" | "critical";
};

/** Pending plugin approval view including available decision actions. */
export type PluginApprovalPendingView = PluginApprovalViewBase & {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

/** Resolved plugin approval view after an operator decision. */
export type PluginApprovalResolvedView = PluginApprovalViewBase & {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

/** Expired plugin approval view after the approval window closes. */
export type PluginApprovalExpiredView = PluginApprovalViewBase & {
  phase: "expired";
};

/** Pending approval view discriminated by approvalKind for channel-native renderers. */
export type PendingApprovalView = ExecApprovalPendingView | PluginApprovalPendingView;
/** Resolved approval view with the original approval metadata plus final decision fields. */
export type ResolvedApprovalView = ExecApprovalResolvedView | PluginApprovalResolvedView;
/** Expired approval view that preserves request context but has no decision/actions. */
export type ExpiredApprovalView = ExecApprovalExpiredView | PluginApprovalExpiredView;
/** Any channel-renderable approval view, discriminated by phase and approvalKind. */
export type ApprovalViewModel = PendingApprovalView | ResolvedApprovalView | ExpiredApprovalView;

/** Raw approval request union accepted by the view-model builders. */
export type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
/** Raw approval resolution union accepted by resolved view-model builders. */
export type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
