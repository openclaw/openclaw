export const CONTROL_UI_BOOTSTRAP_CONFIG_PATH = "/__openclaw/control-ui-config.json";
export const CONTROL_UI_GROWTH_FOUNDATION_PATH = "/__openclaw/growth-foundation.json";
export const CONTROL_UI_GROWTH_FILE_PATH = "/__openclaw/growth-foundation/file";
export const CONTROL_UI_GROWTH_REVIEW_ACTION_PATH = "/__openclaw/growth-foundation/review-action";

export type ControlUiGrowthReviewAction = "complete" | "reopen";

export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAgentId: string;
  serverVersion?: string;
};

export type ControlUiGrowthReviewItem = {
  key: string;
  text: string;
  display: string;
  completedAt: string | null;
  source: string | null;
};

export type ControlUiGrowthCompletionEntry = {
  timestamp: string;
  action: string;
  itemKey: string;
  weekly: string;
  weeklyPath: string | null;
  source: string;
  text: string;
};

export type ControlUiGrowthCodexSmokeBackfillItem = {
  period: string;
  jobId: string | null;
  requestedAt: string | null;
  reason: string | null;
  jobPath: string | null;
  evidencePath: string | null;
};

export type ControlUiGrowthCodexReviewBackfillItem = {
  period: string;
  jobId: string | null;
  requestedAt: string | null;
  reason: string | null;
  sourceJobId: string | null;
  sourceOrigin: string | null;
  diffRelpath: string | null;
  jobPath: string | null;
  evidencePath: string | null;
};

export type ControlUiGrowthNotificationItem = {
  id: string;
  severity: "danger" | "warning" | "info";
  title: string;
  detail: string;
  path: string | null;
  source: "alerts" | "actions" | "weekly";
};

export type ControlUiGrowthIssueFlowRun = {
  issueNumber: number;
  issueRef: string | null;
  stage: string | null;
  status: string;
  updatedAt: string | null;
  directoryPath: string;
  preflightStatus: string;
  draftStatus: string;
  proposalStatus: string;
  enqueueStatus: string;
  outcomeStatus: string;
  preflightPath: string | null;
  draftPath: string | null;
  proposalPath: string | null;
  receiptPath: string | null;
  outcomePath: string | null;
  primaryResultPath: string | null;
};

export type ControlUiGrowthFoundationSnapshot = {
  available: boolean;
  projectId: string | null;
  workspaceProjectId?: string | null;
  alertStatus: string;
  alertTransition: string | null;
  alertUpdatedAt: string | null;
  actionsStatus: string;
  actionsUpdatedAt: string | null;
  priorityNow: string[];
  thisWeek: string[];
  thisWeekItems: ControlUiGrowthReviewItem[];
  completedThisWeekItems: ControlUiGrowthReviewItem[];
  completedHistoryItems: ControlUiGrowthCompletionEntry[];
  notificationStatus: string;
  notificationCount: number;
  notificationItems: ControlUiGrowthNotificationItem[];
  watch: string[];
  reviewCount: number;
  completedReviewCount: number;
  alertsPath: string | null;
  actionsPath: string | null;
  completedHistoryPath: string | null;
  heartbeatPath: string | null;
  weeklyReviewPath: string | null;
  codexSmokeStatus: string;
  codexSmokePeriod: string | null;
  codexSmokeJobId: string | null;
  codexSmokeUpdatedAt: string | null;
  codexSmokeStatePath: string | null;
  codexReviewSmokeStatus: string;
  codexReviewSmokePeriod: string | null;
  codexReviewSmokeJobId: string | null;
  codexReviewSmokeSourceJobId: string | null;
  codexReviewSmokeUpdatedAt: string | null;
  codexReviewSmokeStatePath: string | null;
  codexReviewSmokeDiffPath: string | null;
  codexReviewSmokeBackfillCount: number;
  codexReviewSmokeBackfillItems: ControlUiGrowthCodexReviewBackfillItem[];
  codexReviewSmokeBackfillStatePath: string | null;
  codexSmokeBackfillCount: number;
  codexSmokeBackfillItems: ControlUiGrowthCodexSmokeBackfillItem[];
  codexSmokeBackfillStatePath: string | null;
  githubSyncStatus: string;
  githubSyncIssueCount: number;
  githubSyncUpdatedAt: string | null;
  githubSyncCurrentPath: string | null;
  githubProjectStatus: string;
  githubProjectTitle: string | null;
  githubProjectUrl: string | null;
  githubProjectItemCount: number;
  githubWritebackStatus: string;
  githubWritebackIssueRef: string | null;
  githubWritebackActions: string[];
  githubWritebackCloseIssue: boolean;
  githubWritebackOperator: string | null;
  githubWritebackProposalUpdatedAt: string | null;
  githubWritebackReceiptAppliedAt: string | null;
  githubWritebackProposalPath: string | null;
  githubWritebackReceiptPath: string | null;
  issueFlowStatus?: string;
  issueFlowStage?: string | null;
  issueFlowIssueNumber?: number | null;
  issueFlowIssueRef?: string | null;
  issueFlowUpdatedAt?: string | null;
  issueFlowDirectoryPath?: string | null;
  issueFlowPreflightStatus?: string;
  issueFlowDraftStatus?: string;
  issueFlowProposalStatus?: string;
  issueFlowEnqueueStatus?: string;
  issueFlowOutcomeStatus?: string;
  issueFlowPreflightPath?: string | null;
  issueFlowDraftPath?: string | null;
  issueFlowProposalPath?: string | null;
  issueFlowReceiptPath?: string | null;
  issueFlowOutcomePath?: string | null;
  issueFlowPrimaryResultPath?: string | null;
  issueFlowActiveCount?: number;
  issueFlowRecentCount?: number;
  issueFlowRecentItems?: ControlUiGrowthIssueFlowRun[];
  issueFlowArchivedCount?: number;
  issueFlowArchiveRootPath?: string | null;
  issueFlowArchivedLatestIssueRef?: string | null;
  issueFlowArchivedLatestArchivedAt?: string | null;
  issueFlowArchivedLatestPath?: string | null;
  issueFlowArchivedLatestReceiptPath?: string | null;
  issueFlowVisibilityStatus?: string;
  issueFlowVisibilityReason?: string | null;
  issueFlowVisibilityOpenIssue?: boolean | null;
  issueFlowVisibilityGithubSyncUpdatedAt?: string | null;
  relayStatus: string;
  relayChannel: string | null;
  relayMode: string | null;
  relayCandidateCount: number;
  relayUpdatedAt: string | null;
  relayCurrentPath: string | null;
};

export type ControlUiGrowthReviewActionResponse = {
  success: boolean;
  action: ControlUiGrowthReviewAction;
  itemKey: string;
  snapshot: ControlUiGrowthFoundationSnapshot | null;
  error?: string;
};
