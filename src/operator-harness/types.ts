export const operatorReviewRoles = ["qa", "ux", "ai"] as const;
export const operatorWorkerRoles = ["builder", ...operatorReviewRoles] as const;
export const operatorAllRoles = [...operatorWorkerRoles, "spot-check"] as const;

export type OperatorReviewRole = (typeof operatorReviewRoles)[number];
export type OperatorWorkerRole = (typeof operatorWorkerRoles)[number];
export type OperatorRole = (typeof operatorAllRoles)[number];

export type BrowserWalkthroughAction =
  | "open"
  | "wait_load"
  | "wait_for"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "scroll"
  | "screenshot"
  | "assert_text"
  | "pause";

export interface BrowserWalkthroughStep {
  action: BrowserWalkthroughAction;
  target?: string;
  value?: string;
  path?: string;
  waitMs?: number;
  annotate?: boolean;
  fullPage?: boolean;
}

export interface NotionPageEntry {
  id: string;
  url: string;
  title: string;
  summary: string;
  markdown: string;
  relevantScreens: string[];
  imageUrls: string[];
  updatedAt: string;
}

export interface HarnessAgentConfig {
  name: string;
  title: string;
  role: OperatorWorkerRole;
  model?: string;
  instructionsFile: string;
  capabilities?: string;
  search?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

export interface HarnessTicketOverride {
  summary?: string;
  acceptanceCriteria?: string[];
  startupCommand?: string;
  healthcheckUrl?: string;
  browserWalkthrough?: BrowserWalkthroughStep[];
  reviewRoles?: OperatorReviewRole[];
  notionUrls?: string[];
  relevantScreens?: string[];
  environmentPrerequisites?: string[];
  requiredArtifacts?: string[];
}

export interface HarnessConfig {
  paperclip: {
    apiBase: string;
    companyName: string;
    projectName: string;
  };
  linear: {
    teamKey: string;
    readyStateTypes: string[];
    readyStateNames: string[];
    preferredProjectNames?: string[];
    excludedProjectNames?: string[];
    listLimit?: number;
  };
  notion: {
    authEnv?: string;
    version?: string;
    baselineUrls?: string[];
  };
  workspace: {
    repoKey: string;
    repoName: string;
    repoCwd: string;
    repoUrl?: string;
    baseBranch: string;
    branchPrefix?: string;
    ticketWorkspaceRootDir?: string;
    installCommand?: string;
    defaultStartupCommand?: string;
    defaultHealthcheckUrl?: string;
    defaultBrowserWalkthrough?: BrowserWalkthroughStep[];
  };
  artifacts: {
    rootDir: string;
  };
  agents: {
    builder: HarnessAgentConfig;
    qa: HarnessAgentConfig;
    ux?: HarnessAgentConfig;
    ai?: HarnessAgentConfig;
  };
  reviewRules: {
    default: OperatorReviewRole[];
    ui: OperatorReviewRole[];
    ai: OperatorReviewRole[];
  };
  ticketOverrides?: Record<string, HarnessTicketOverride>;
}

export interface HarnessState {
  companyId?: string;
  projectId?: string;
  projectWorkspaceId?: string;
  paused?: boolean;
  agentIds?: Partial<Record<OperatorWorkerRole, string>>;
}

export interface LinearIssueRef {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  priority: number;
  state: {
    id: string;
    name: string;
    type: string;
  };
  labels: string[];
  projectName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NextTicketCandidate {
  ticketKey: string;
  title: string;
  url: string;
  priority: number | null;
  state: {
    id: string;
    name: string;
    type: string;
  } | null;
  reason: "pending-review" | "ready-backlog";
}

export interface OperatorHarnessSummary {
  ready: number;
  active: number;
  blocked: number;
  pendingReviews: number;
  missingEvidence: number;
}

export type OperatorTicketLifecycle =
  | "ready"
  | "active"
  | "blocked"
  | "review-needed"
  | "reviewing"
  | "spot-check-needed"
  | "done";

export interface OperatorPulseTicket {
  ticketKey: string;
  title: string;
  upstreamUrl: string;
  parentStatus: string;
  lifecycle: OperatorTicketLifecycle;
  builderStatus: string | null;
  requiredReviewRoles: OperatorReviewRole[];
  reviewRequested: boolean;
  reviewStatuses: Array<{
    role: OperatorReviewRole;
    status: string | null;
  }>;
  missingReviewRoles: OperatorReviewRole[];
  spotCheckStatus: string | null;
  spotCheckNeeded: boolean;
  activeRun: boolean;
  missingEvidence: boolean;
  evidence: string[];
  updatedAt: string;
}

export interface OperatorPulseSnapshot {
  summary: OperatorHarnessSummary;
  tickets: OperatorPulseTicket[];
  nextCandidate: NextTicketCandidate | null;
  paused: boolean;
  agents: Array<{
    id: string;
    name: string;
    status: string;
    companyId?: string;
  }>;
  liveRuns: Array<{
    id: string;
    agentId: string;
    issueId: string | null;
  }>;
}

export interface SpecPacket {
  kind: "parent";
  contractId: string;
  externalTicketId: string;
  upstreamIssueId: string;
  title: string;
  summary: string;
  upstreamUrl: string;
  notionUrls: string[];
  storyboardHubUrls: string[];
  acceptanceCriteria: string[];
  startupCommand: string;
  healthcheckUrl: string;
  browserWalkthrough: BrowserWalkthroughStep[];
  requiredArtifacts: string[];
  requiredReviewRoles: OperatorReviewRole[];
  relevantScreens: string[];
  notionPages: Array<{
    id: string;
    url: string;
    title: string;
    summary: string;
  }>;
  repoKey: string;
  repoName: string;
  repoCwd: string;
  repoUrl: string | null;
  baseBranch: string;
  environmentPrerequisites: string[];
}

export interface TaskPacket {
  kind: "task";
  contractId: string;
  externalTicketId: string;
  role: OperatorRole;
  summary: string;
  upstreamUrl: string;
  startupCommand: string;
  healthcheckUrl: string;
  browserWalkthrough: BrowserWalkthroughStep[];
  requiredArtifacts: string[];
  artifactDir: string;
  repoRelativeArtifactDir: string;
  repoCwd: string;
  branchName: string;
  baseBranch: string;
  gitRemoteName: string;
  prRequired: boolean;
  prTitle: string;
  prBodyPath: string;
  validationCommand?: string;
  prSyncCommand?: string;
  finalizeCommand?: string;
  prUrl?: string | null;
  specPacketPath?: string;
  taskPacketPath?: string;
  notionUrls: string[];
  acceptanceCriteria: string[];
  relevantScreens: string[];
}

export interface ManagedIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  parentId: string | null;
  projectId: string | null;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  updatedAt: string;
  activeRun?: {
    id: string;
    status: string;
    agentId: string;
    invocationSource: string;
    triggerDetail: string | null;
    createdAt: string;
    startedAt: string | null;
  } | null;
}

export interface ManagedIssueGroup {
  parent: ManagedIssueSummary;
  specPacket: SpecPacket;
  subtasks: Array<ManagedIssueSummary & { taskPacket: TaskPacket | null }>;
}

export interface ArtifactCheckResult {
  artifactDir: string;
  missingArtifacts: string[];
  presentArtifacts: string[];
}
