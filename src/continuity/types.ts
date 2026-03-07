import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionSendPolicyConfig } from "../config/types.base.js";

export type ContinuityKind = "fact" | "preference" | "decision" | "open_loop";
export type ContinuityReviewState = "pending" | "approved" | "rejected";
export type ContinuityCaptureMode = "off" | "review" | "auto";
export type ContinuitySourceClass = "main_direct" | "paired_direct" | "group" | "channel";

export type ContinuitySource = {
  role: "user" | "assistant";
  sessionKey?: string;
  sessionId?: string;
  excerpt: string;
};

export type ContinuityBaseRecord = {
  id: string;
  kind: ContinuityKind;
  text: string;
  normalizedText: string;
  confidence: number;
  sourceClass: ContinuitySourceClass;
  source: ContinuitySource;
  createdAt: number;
  updatedAt: number;
};

export type ContinuityPending = ContinuityBaseRecord & {
  reviewState: "pending";
  filePath?: undefined;
  approvedAt?: undefined;
  rejectedAt?: undefined;
};

export type ContinuityRejected = ContinuityBaseRecord & {
  reviewState: "rejected";
  filePath?: undefined;
  approvedAt?: undefined;
  rejectedAt?: number;
};

export type ContinuityItem = ContinuityBaseRecord & {
  reviewState: "approved";
  filePath: string;
  approvedAt: number;
  rejectedAt?: undefined;
};

export type ContinuityCandidate = ContinuityPending | ContinuityRejected;

export type ContinuityRecord = ContinuityPending | ContinuityRejected | ContinuityItem;

export type ContinuityStoreFile = {
  version: 1;
  records: ContinuityRecord[];
};

export type ContinuityCaptureConfig = {
  mainDirect?: ContinuityCaptureMode;
  pairedDirect?: ContinuityCaptureMode;
  group?: ContinuityCaptureMode;
  channel?: ContinuityCaptureMode;
  minConfidence?: number;
};

export type ContinuityReviewConfig = {
  autoApproveMain?: boolean;
  requireSource?: boolean;
};

export type ContinuityRecallConfig = {
  maxItems?: number;
  includeOpenLoops?: boolean;
  scope?: SessionSendPolicyConfig;
};

export type ContinuityPluginConfig = {
  capture?: ContinuityCaptureConfig;
  review?: ContinuityReviewConfig;
  recall?: ContinuityRecallConfig;
};

export type ResolvedContinuityConfig = {
  capture: {
    mainDirect: ContinuityCaptureMode;
    pairedDirect: ContinuityCaptureMode;
    group: ContinuityCaptureMode;
    channel: ContinuityCaptureMode;
    minConfidence: number;
  };
  review: {
    autoApproveMain: boolean;
    requireSource: boolean;
  };
  recall: {
    maxItems: number;
    includeOpenLoops: boolean;
    scope: SessionSendPolicyConfig;
  };
};

export type ContinuityListFilters = {
  state?: ContinuityReviewState | "all";
  kind?: ContinuityKind | "all";
  sourceClass?: ContinuitySourceClass | "all";
  limit?: number;
};

export type ContinuityStatus = {
  enabled: boolean;
  slotSelected: boolean;
  counts: Record<ContinuityReviewState, number>;
  capture: ResolvedContinuityConfig["capture"];
  review: ResolvedContinuityConfig["review"];
  recall: {
    maxItems: number;
    includeOpenLoops: boolean;
  };
};

export type ContinuityPatchAction = "approve" | "reject" | "remove";

export type ContinuityPatchResult = {
  ok: boolean;
  record?: ContinuityRecord;
  removedId?: string;
};

export type ContinuityExplainResult = {
  record: ContinuityRecord;
  markdownPath?: string;
};

export type ContinuityCaptureInput = {
  sessionKey?: string;
  sessionId: string;
  messages: AgentMessage[];
};

export type ContinuityExtractionMatch = {
  kind: ContinuityKind;
  text: string;
  confidence: number;
  role: "user" | "assistant";
};
