import type {
  CreateJobRequest,
  ExecutionAcceptedResponse,
  ExecutionCompletedEvent,
  ExecutionFailedEvent,
  JobResponse,
  ProjectResponse,
  ReviewAcceptedResponse,
  ReviewCompletedEvent,
  StartExecutionCommand,
  StartReviewCommand,
} from "@openclaw/contracts";

export type ActivePlatformProject = ProjectResponse & {
  readonly status: "active";
  /** Private local repository location. Never persisted or sent over HTTP. */
  readonly repositoryPath: string;
};

export type ExecutionOutcome = ExecutionCompletedEvent | ExecutionFailedEvent;

export type ReviewOutcome =
  | ReviewCompletedEvent
  | {
      readonly status: "failed" | "cancelled";
      readonly review_id: string;
    };

export interface ExecutionPort {
  start(command: StartExecutionCommand, idempotencyKey: string): Promise<ExecutionAcceptedResponse>;
  wait(executionId: string): Promise<ExecutionOutcome>;
}

export interface ReviewPort {
  start(command: StartReviewCommand, idempotencyKey: string): Promise<ReviewAcceptedResponse>;
  wait(reviewId: string): Promise<ReviewOutcome>;
}

export type GitPromotionRequest = {
  readonly promotionId: string;
  readonly repositoryPath: string;
  readonly targetBranch: string;
  readonly expectedTargetCommitSha: string;
  readonly sourceCommitSha: string;
  readonly commitMessage: string;
  readonly commitTimestamp: string;
};

export type GitPromotionResult = {
  readonly promotionId: string;
  readonly commitSha: string;
  readonly strategy: "squash";
  readonly pushed: false;
};

export interface GitPromotionPort {
  promote(request: GitPromotionRequest): Promise<GitPromotionResult>;
}

type ExecutionOperation = {
  readonly kind: "execution";
  readonly idempotencyKey: string;
  readonly command: StartExecutionCommand;
  readonly accepted?: ExecutionAcceptedResponse;
};

type ReviewOperation = {
  readonly kind: "review";
  readonly idempotencyKey: string;
  readonly command: StartReviewCommand;
  readonly accepted?: ReviewAcceptedResponse;
};

type PromotionOperation = {
  readonly kind: "promotion";
  readonly request: Omit<GitPromotionRequest, "repositoryPath">;
};

export type PlatformJobFlowState = {
  readonly stateVersion: 1;
  readonly correlationId: string;
  readonly project: {
    readonly projectId: string;
    readonly gitRepositoryId: string;
    readonly baseCommitSha: string;
    readonly targetBranch: string;
  };
  readonly request: CreateJobRequest;
  readonly skillIds: readonly string[];
  readonly job: JobResponse;
  readonly operation?: ExecutionOperation | ReviewOperation | PromotionOperation;
  readonly execution?: ExecutionCompletedEvent;
  readonly review?: ReviewCompletedEvent;
  readonly promotion?: GitPromotionResult;
};

export type StoredPlatformJob = {
  readonly flowId: string;
  readonly revision: number;
  readonly state: PlatformJobFlowState;
};

export interface PlatformJobStatePort {
  create(state: PlatformJobFlowState): StoredPlatformJob;
  get(flowId: string): StoredPlatformJob | undefined;
  save(flowId: string, expectedRevision: number, state: PlatformJobFlowState): StoredPlatformJob;
}

export interface PlatformIdentityPort {
  createId(kind: "job" | "message" | "promotion", now: number): string;
}
