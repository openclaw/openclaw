import { randomBytes } from "node:crypto";
import type {
  CreateJobRequest,
  ExecutionAcceptedResponse,
  ExecutionCompletedEvent,
  ExecutionFailedEvent,
  JobResponse,
  ReviewAcceptedResponse,
  StartExecutionCommand,
  StartReviewCommand,
} from "@openclaw/contracts";
import { assertPlatformContract } from "./contracts-runtime.js";
import type {
  ActivePlatformProject,
  ExecutionOutcome,
  ExecutionPort,
  GitPromotionResult,
  GitPromotionPort,
  PlatformIdentityPort,
  PlatformJobFlowState,
  PlatformJobStatePort,
  ReviewOutcome,
  ReviewPort,
  StoredPlatformJob,
} from "./platform-job-ports.js";

const ID_PREFIXES = {
  job: "job_",
  message: "msg_",
  promotion: "pro_",
} as const;

const ALLOWED_TRANSITIONS = new Map<JobResponse["status"], ReadonlySet<JobResponse["status"]>>([
  ["queued", new Set<JobResponse["status"]>(["executing", "failed"])],
  ["executing", new Set<JobResponse["status"]>(["awaiting_review", "failed"])],
  ["awaiting_review", new Set<JobResponse["status"]>(["reviewing", "failed"])],
  [
    "reviewing",
    new Set<JobResponse["status"]>(["approved", "changes_requested", "cancelled", "failed"]),
  ],
  ["approved", new Set<JobResponse["status"]>(["promoting", "failed"])],
  ["promoting", new Set<JobResponse["status"]>(["completed", "failed"])],
]);

export type PlatformJobErrorCode =
  | "platform_execution_accepted_identity_mismatch"
  | "platform_execution_terminal_identity_mismatch"
  | "platform_review_accepted_identity_mismatch"
  | "platform_review_terminal_identity_mismatch"
  | "platform_promotion_identity_mismatch"
  | "platform_resume_identity_mismatch"
  | "platform_state_conflict"
  | "platform_operation_failed";

export class PlatformJobError extends Error {
  constructor(readonly code: PlatformJobErrorCode) {
    super(code);
    this.name = "PlatformJobError";
  }
}

function uuidV7(now: number): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export class PlatformIdentity implements PlatformIdentityPort {
  createId(kind: keyof typeof ID_PREFIXES, now: number): string {
    return `${ID_PREFIXES[kind]}${uuidV7(now)}`;
  }
}

export type RunPlatformJobParams = {
  readonly project: ActivePlatformProject;
  readonly request: CreateJobRequest;
  readonly skillIds: readonly string[];
};

export type ResumePlatformJobParams = {
  readonly flowId: string;
  readonly project: ActivePlatformProject;
};

export type PlatformJobOrchestratorOptions = {
  readonly executions: ExecutionPort;
  readonly reviews: ReviewPort;
  readonly promotions: GitPromotionPort;
  readonly state: PlatformJobStatePort;
  readonly identity?: PlatformIdentityPort;
  readonly now?: () => Date;
};

export class PlatformJobOrchestrator {
  readonly #executions: ExecutionPort;
  readonly #reviews: ReviewPort;
  readonly #promotions: GitPromotionPort;
  readonly #state: PlatformJobStatePort;
  readonly #identity: PlatformIdentityPort;
  readonly #now: () => Date;

  constructor(options: PlatformJobOrchestratorOptions) {
    this.#executions = options.executions;
    this.#reviews = options.reviews;
    this.#promotions = options.promotions;
    this.#state = options.state;
    this.#identity = options.identity ?? new PlatformIdentity();
    this.#now = options.now ?? (() => new Date());
  }

  async run(params: RunPlatformJobParams): Promise<StoredPlatformJob> {
    this.#assertInput(params);
    return await this.#drive(this.#createState(params), params.project);
  }

  async resume(params: ResumePlatformJobParams): Promise<StoredPlatformJob> {
    const current = this.#state.get(params.flowId);
    if (!current) {
      throw new PlatformJobError("platform_resume_identity_mismatch");
    }
    this.#assertResumeProject(current.state, params.project);
    return await this.#drive(current, params.project);
  }

  #assertInput(params: RunPlatformJobParams): void {
    const { repositoryPath: _repositoryPath, ...projectContract } = params.project;
    assertPlatformContract("ProjectResponse", projectContract);
    assertPlatformContract("CreateJobRequest", params.request);
    if (params.project.status !== "active") {
      throw new Error("platform project is not active");
    }
    if (params.project.project_id !== params.request.project_id) {
      throw new Error("platform job project does not match the active project");
    }
    if (!params.project.repositoryPath.trim()) {
      throw new Error("platform project repository path is required");
    }
    if (params.skillIds.length === 0) {
      throw new Error("platform execution requires at least one skill");
    }
  }

  #createState(params: RunPlatformJobParams): StoredPlatformJob {
    const now = this.#now();
    const timestamp = now.toISOString();
    const job: JobResponse = {
      schema_version: "1.0.0",
      job_id: this.#identity.createId("job", now.getTime()),
      project_id: params.project.project_id,
      aggregate_version: 1,
      status: "queued",
      task: params.request.task,
      priority: params.request.priority,
      created_at: timestamp,
      updated_at: timestamp,
    };
    assertPlatformContract("JobResponse", job);
    return this.#state.create({
      stateVersion: 1,
      correlationId: this.#identity.createId("message", now.getTime()),
      project: {
        projectId: params.project.project_id,
        gitRepositoryId: params.project.git_repository_id,
        baseCommitSha: params.project.head_commit_sha,
        targetBranch: params.project.default_branch,
      },
      request: params.request,
      skillIds: params.skillIds,
      job,
    });
  }

  async #drive(
    initial: StoredPlatformJob,
    project: ActivePlatformProject,
  ): Promise<StoredPlatformJob> {
    let current = initial;
    while (true) {
      switch (current.state.job.status) {
        case "queued":
          current = this.#beginExecution(current);
          break;
        case "executing":
          current = await this.#continueExecution(current);
          break;
        case "awaiting_review":
          current = this.#beginReview(current);
          break;
        case "reviewing":
          current = await this.#continueReview(current);
          break;
        case "approved":
          current = this.#beginPromotion(current);
          break;
        case "promoting":
          current = await this.#continuePromotion(current, project.repositoryPath);
          break;
        default:
          return current;
      }
    }
  }

  #beginExecution(current: StoredPlatformJob): StoredPlatformJob {
    const command = this.#executionCommand(current.state);
    return this.#transition(
      current,
      "executing",
      {},
      {
        operation: {
          kind: "execution",
          idempotencyKey: `${current.state.job.job_id}:execution:1`,
          command,
        },
      },
    );
  }

  async #continueExecution(current: StoredPlatformJob): Promise<StoredPlatformJob> {
    let checkpoint = current;
    const operation = current.state.operation;
    if (operation?.kind !== "execution") {
      throw new PlatformJobError("platform_resume_identity_mismatch");
    }
    let accepted = operation.accepted;
    if (!accepted) {
      accepted = await this.#call(() =>
        this.#executions.start(operation.command, operation.idempotencyKey),
      );
      this.#assertExecutionAccepted(operation.command, accepted);
      checkpoint = this.#checkpoint(current, {
        jobPatch: { current_execution_id: accepted.execution_id },
        statePatch: { operation: { ...operation, accepted } },
      });
    } else {
      this.#assertExecutionAccepted(operation.command, accepted);
    }

    const outcome = await this.#call(() => this.#executions.wait(accepted.execution_id));
    this.#assertExecutionOutcome(checkpoint.state, operation.command, accepted, outcome);
    if ("failure_code" in outcome) {
      return this.#transition(checkpoint, "failed", {}, { operation: undefined });
    }
    return this.#transition(
      checkpoint,
      "awaiting_review",
      {},
      { operation: undefined, execution: outcome },
    );
  }

  #beginReview(current: StoredPlatformJob): StoredPlatformJob {
    const command = this.#reviewCommand(current.state);
    return this.#transition(
      current,
      "reviewing",
      {},
      {
        operation: {
          kind: "review",
          idempotencyKey: `${current.state.job.job_id}:review:1`,
          command,
        },
      },
    );
  }

  async #continueReview(current: StoredPlatformJob): Promise<StoredPlatformJob> {
    let checkpoint = current;
    const operation = current.state.operation;
    if (operation?.kind !== "review") {
      throw new PlatformJobError("platform_resume_identity_mismatch");
    }
    let accepted = operation.accepted;
    if (!accepted) {
      accepted = await this.#call(() =>
        this.#reviews.start(operation.command, operation.idempotencyKey),
      );
      this.#assertReviewAccepted(operation.command, accepted);
      checkpoint = this.#checkpoint(current, {
        jobPatch: { current_review_id: accepted.review_id },
        statePatch: { operation: { ...operation, accepted } },
      });
    } else {
      this.#assertReviewAccepted(operation.command, accepted);
    }

    const outcome = await this.#call(() => this.#reviews.wait(accepted.review_id));
    this.#assertReviewOutcome(checkpoint.state, operation.command, accepted, outcome);
    if ("status" in outcome) {
      return this.#transition(
        checkpoint,
        outcome.status === "cancelled" ? "cancelled" : "failed",
        {},
        { operation: undefined },
      );
    }
    if (outcome.decision === "needs_changes") {
      return this.#transition(
        checkpoint,
        "changes_requested",
        {},
        { operation: undefined, review: outcome },
      );
    }
    if (outcome.decision === "rejected") {
      return this.#transition(checkpoint, "failed", {}, { operation: undefined, review: outcome });
    }
    return this.#transition(checkpoint, "approved", {}, { operation: undefined, review: outcome });
  }

  #beginPromotion(current: StoredPlatformJob): StoredPlatformJob {
    const execution = current.state.execution;
    if (!execution) {
      throw new PlatformJobError("platform_resume_identity_mismatch");
    }
    const promotionId = this.#createId("promotion");
    return this.#transition(
      current,
      "promoting",
      { current_promotion_id: promotionId },
      {
        operation: {
          kind: "promotion",
          request: {
            promotionId,
            targetBranch: current.state.project.targetBranch,
            expectedTargetCommitSha: current.state.project.baseCommitSha,
            sourceCommitSha: execution.commit_sha,
            commitMessage: `chore(platform): promote ${current.state.job.job_id}`,
            commitTimestamp: this.#now().toISOString(),
          },
        },
      },
    );
  }

  async #continuePromotion(
    current: StoredPlatformJob,
    repositoryPath: string,
  ): Promise<StoredPlatformJob> {
    const operation = current.state.operation;
    if (operation?.kind !== "promotion") {
      throw new PlatformJobError("platform_resume_identity_mismatch");
    }
    const promotion = await this.#call(() =>
      this.#promotions.promote({ ...operation.request, repositoryPath }),
    );
    this.#assertPromotionResult(operation.request.promotionId, promotion);
    return this.#transition(current, "completed", {}, { operation: undefined, promotion });
  }

  #transition(
    current: StoredPlatformJob,
    status: JobResponse["status"],
    jobPatch: Partial<JobResponse> = {},
    statePatch: Partial<PlatformJobFlowState> = {},
  ): StoredPlatformJob {
    if (!ALLOWED_TRANSITIONS.get(current.state.job.status)?.has(status)) {
      throw new Error(`invalid platform job transition: ${current.state.job.status} -> ${status}`);
    }
    const job: JobResponse = {
      ...current.state.job,
      ...jobPatch,
      status,
      aggregate_version: current.state.job.aggregate_version + 1,
      updated_at: this.#now().toISOString(),
    };
    assertPlatformContract("JobResponse", job);
    return this.#save(current, { ...current.state, ...statePatch, job });
  }

  #checkpoint(
    current: StoredPlatformJob,
    patches: {
      readonly jobPatch: Partial<JobResponse>;
      readonly statePatch: Partial<PlatformJobFlowState>;
    },
  ): StoredPlatformJob {
    const job = assertPlatformContract("JobResponse", {
      ...current.state.job,
      ...patches.jobPatch,
      aggregate_version: current.state.job.aggregate_version + 1,
      updated_at: this.#now().toISOString(),
    });
    return this.#save(current, { ...current.state, ...patches.statePatch, job });
  }

  #save(current: StoredPlatformJob, state: PlatformJobFlowState): StoredPlatformJob {
    try {
      return this.#state.save(current.flowId, current.revision, state);
    } catch {
      throw new PlatformJobError("platform_state_conflict");
    }
  }

  #executionCommand(state: PlatformJobFlowState): StartExecutionCommand {
    const now = this.#now();
    return assertPlatformContract("StartExecutionCommand", {
      schema_version: "1.0.0",
      message_id: this.#identity.createId("message", now.getTime()),
      correlation_id: state.correlationId,
      occurred_at: now.toISOString(),
      project_id: state.project.projectId,
      job_id: state.job.job_id,
      git_repository_id: state.project.gitRepositoryId,
      base_commit_sha: state.project.baseCommitSha,
      task: state.request.task,
      ...(state.request.constraints ? { constraints: state.request.constraints } : {}),
      ...(state.request.policy_ids ? { policy_ids: state.request.policy_ids } : {}),
      skill_ids: state.skillIds,
    });
  }

  #reviewCommand(state: PlatformJobFlowState): StartReviewCommand {
    const execution = state.execution;
    if (!execution) {
      throw new Error("platform job has no completed execution");
    }
    const now = this.#now();
    return assertPlatformContract("StartReviewCommand", {
      schema_version: "1.0.0",
      message_id: this.#identity.createId("message", now.getTime()),
      correlation_id: state.correlationId,
      occurred_at: now.toISOString(),
      project_id: state.project.projectId,
      job_id: state.job.job_id,
      execution_id: execution.execution_id,
      git_repository_id: state.project.gitRepositoryId,
      commit_sha: execution.commit_sha,
      worktree_id: execution.worktree_id,
      artifact_ids: execution.artifact_ids,
      evidence_ids: execution.evidence_ids,
      ...(state.request.policy_ids ? { policy_ids: state.request.policy_ids } : {}),
    });
  }

  #createId(kind: "promotion"): string {
    return this.#identity.createId(kind, this.#now().getTime());
  }

  async #call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PlatformJobError) {
        throw error;
      }
      throw new PlatformJobError("platform_operation_failed");
    }
  }

  #assertResumeProject(state: PlatformJobFlowState, project: ActivePlatformProject): void {
    if (
      project.status !== "active" ||
      !project.repositoryPath.trim() ||
      project.project_id !== state.project.projectId ||
      project.git_repository_id !== state.project.gitRepositoryId ||
      project.head_commit_sha !== state.project.baseCommitSha ||
      project.default_branch !== state.project.targetBranch
    ) {
      throw new PlatformJobError("platform_resume_identity_mismatch");
    }
  }

  #assertExecutionAccepted(
    command: StartExecutionCommand,
    accepted: ExecutionAcceptedResponse,
  ): void {
    if (
      accepted.project_id !== command.project_id ||
      accepted.job_id !== command.job_id ||
      accepted.correlation_id !== command.correlation_id
    ) {
      throw new PlatformJobError("platform_execution_accepted_identity_mismatch");
    }
  }

  #assertExecutionOutcome(
    state: PlatformJobFlowState,
    command: StartExecutionCommand,
    accepted: ExecutionAcceptedResponse,
    outcome: ExecutionOutcome,
  ): asserts outcome is ExecutionCompletedEvent | ExecutionFailedEvent {
    if (
      outcome.project_id !== state.project.projectId ||
      outcome.job_id !== state.job.job_id ||
      outcome.execution_id !== accepted.execution_id ||
      outcome.correlation_id !== state.correlationId ||
      outcome.causation_id !== command.message_id
    ) {
      throw new PlatformJobError("platform_execution_terminal_identity_mismatch");
    }
  }

  #assertReviewAccepted(command: StartReviewCommand, accepted: ReviewAcceptedResponse): void {
    if (
      accepted.project_id !== command.project_id ||
      accepted.job_id !== command.job_id ||
      accepted.execution_id !== command.execution_id ||
      accepted.correlation_id !== command.correlation_id
    ) {
      throw new PlatformJobError("platform_review_accepted_identity_mismatch");
    }
  }

  #assertReviewOutcome(
    state: PlatformJobFlowState,
    command: StartReviewCommand,
    accepted: ReviewAcceptedResponse,
    outcome: ReviewOutcome,
  ): void {
    if ("status" in outcome) {
      if (outcome.review_id !== accepted.review_id) {
        throw new PlatformJobError("platform_review_terminal_identity_mismatch");
      }
      return;
    }
    const artifactIds = new Set(outcome.artifact_ids);
    const commandArtifactsMatch =
      artifactIds.size === command.artifact_ids.length &&
      command.artifact_ids.every((artifactId) => artifactIds.has(artifactId));
    const findingArtifactsMatch = outcome.findings.every(
      (finding) => !finding.artifact_id || artifactIds.has(finding.artifact_id),
    );
    if (
      outcome.project_id !== state.project.projectId ||
      outcome.job_id !== state.job.job_id ||
      outcome.execution_id !== accepted.execution_id ||
      outcome.review_id !== accepted.review_id ||
      outcome.correlation_id !== state.correlationId ||
      outcome.causation_id !== command.message_id ||
      !commandArtifactsMatch ||
      !findingArtifactsMatch
    ) {
      throw new PlatformJobError("platform_review_terminal_identity_mismatch");
    }
  }

  #assertPromotionResult(promotionId: string, result: GitPromotionResult): void {
    if (result.promotionId !== promotionId || result.strategy !== "squash" || result.pushed) {
      throw new PlatformJobError("platform_promotion_identity_mismatch");
    }
  }
}
