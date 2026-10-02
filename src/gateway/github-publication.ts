import { randomUUID } from "node:crypto";
import type {
  SessionGitHubPublicationResult,
  SessionGitHubReviewParams,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import { encodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { readGitHubPublicationSessionLifecycleInWorker } from "../state/github-publication-session-lifecycles.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { readPersonalGitHubPublication } from "./github-personal-publication-store.js";
import { createPersonalGitHubPublicationCoordinator } from "./github-personal-publication.js";
import { insertGitHubPublicationRequest } from "./github-publication-admission.js";
import {
  assertExpectedSharedGitHubPublisher,
  prepareCurrentGitHubPublicationIdentity,
  resolveGitHubPublicationWorktreeOwner,
  prepareGitHubPublicationWorkspaceOwner,
  type PublicationSessionIdentity,
} from "./github-publication-availability.js";
import {
  createGitHubPublicationCoordinatorMethods,
  exactClaimForPlacement,
  type GitHubPublicationClaimRequest,
} from "./github-publication-coordinator-methods.js";
import { deferSharedGitHubPublicationChanged } from "./github-publication-events.js";
import { GitHubPublicationAuthorityLostError } from "./github-publication-execution-identity.js";
import {
  executeGitHubPublication,
  reconcileGitHubPublication,
} from "./github-publication-executor.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import { readGitHubPublicationRequestInWorker } from "./github-publication-recovery.js";
import {
  restoreGitHubPublicationRequester,
  type GitHubPublicationRequester,
} from "./github-publication-requester.js";
import { captureGitHubPublicationReview } from "./github-publication-review-capture.js";
import {
  assertDurableGitHubPublicationReview,
  type PreparedGitHubPublicationReview,
} from "./github-publication-review-contract.js";
import {
  readGitHubPublicationReview,
  readGitHubPublicationReviewCandidate,
  findGitHubPublicationReview,
  insertGitHubPublicationReview,
  listUnreportedGitHubPublicationReviews,
  markGitHubPublicationReviewReported,
  retireGitHubPublicationReviewReport,
  type GitHubPublicationReviewRow,
} from "./github-publication-review-store.js";
import {
  createGitHubPublicationReviewHolds,
  requireGitHubPublicationReview,
  publicationNeedsReviewConfirmation,
  projectGitHubPublicationReview,
  assertGitHubPublicationReviewSession,
} from "./github-publication-review.js";
import {
  claimGitHubPublicationExecution as claimExecution,
  createGitHubPublicationExecutionStore,
  deferGitHubPublicationRequests as deferRequests,
  digestGitHubPublicationRequest as digestRequest,
  assertStoredGitHubPublicationClaim,
  ensureGitHubPublicationStore as ensureSchema,
  githubPublicationDatabase as publicationDb,
  isGitHubPublicationExecutionOwner as ownsExecution,
  listGitHubPublicationsForClaim,
  projectGitHubPublicationResult as publicationResult,
  readGitHubPublicationRequest,
} from "./github-publication-store.js";
import { readRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import { createRepositoryGitHubPublicationCoordinator } from "./github-repository-publication.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

const activePublicationExecutions = new Map<string, Promise<SessionGitHubPublicationResult>>();

function sameWorktree(
  row: PublicationRow,
  worktree: ReturnType<typeof resolveGitHubPublicationWorktreeOwner>["worktree"],
): boolean {
  return (
    row.worktree_id === worktree.id &&
    row.repository_fingerprint === worktree.repoFingerprint &&
    row.branch === worktree.branch
  );
}

export type GitHubPublicationCoordinator = ReturnType<typeof createGitHubPublicationCoordinator>;

export function createGitHubPublicationCoordinator(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
}) {
  const instanceId = params.placements.workspaceResultInstanceId();
  const reviews = createGitHubPublicationReviewHolds(params.placements);

  const readById = (requestId: string): PublicationRow | undefined => {
    ensureSchema();
    const db = openOpenClawStateDatabase().db;
    return readGitHubPublicationRequest(db, { requestId });
  };

  const requestForClaim = async (
    request: GitHubPublicationClaimRequest,
  ): Promise<SessionGitHubPublicationResult> => {
    ensureSchema();
    const assertRequester = request.requester.assertCurrent;
    assertRequester();
    if (!params.placements.validateTurnClaim(request.claim)) {
      throw new Error("GitHub publication lost the live session turn claim.");
    }
    const placement = params.placements.get(request.claim.sessionId);
    if (
      !placement ||
      placement.sessionKey !== request.sessionKey ||
      placement.agentId !== request.agentId
    ) {
      throw new Error("GitHub publication session identity changed.");
    }
    const admitted = resolveGitHubPublicationWorktreeOwner({
      sessionId: request.claim.sessionId,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
    });
    assertRequester();
    requireGitHubPublicationReview({
      sandbox: admitted.loaded.entry?.sandbox,
      requester: request.requester,
      review: request.preparedReview,
    });
    const identity = await prepareCurrentGitHubPublicationIdentity(request.agentId);
    assertRequester();
    assertExpectedSharedGitHubPublisher(
      request.expectedPublisher,
      { source: identity.source, ...identity.account },
      {
        idempotencyKey: request.idempotencyKey,
        hasRequest: () =>
          Boolean(
            readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
              sessionId: request.claim.sessionId,
              idempotencyKey: request.idempotencyKey,
            }),
          ),
      },
    );
    if (!params.placements.validateTurnClaim(request.claim)) {
      throw new Error("GitHub publication lost the live session turn claim after verification.");
    }
    const { worktree } = resolveGitHubPublicationWorktreeOwner({
      sessionId: request.claim.sessionId,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      lifecycleRevision: admitted.loaded.entry?.lifecycleRevision ?? null,
    });
    const requestDigest = digestRequest({
      sessionId: request.claim.sessionId,
      idempotencyKey: request.idempotencyKey,
      title: request.title,
      body: request.body,
    });
    const now = Date.now();
    const requestId = randomUUID();
    const row = await insertGitHubPublicationRequest(
      {
        request,
        requestId,
        requestDigest,
        now,
        identity,
        worktree,
        sessionId: request.claim.sessionId,
        lifecycleRevision: admitted.loaded.entry?.lifecycleRevision ?? null,
        requester: request.requester.snapshot,
        claim: request.claim,
        snapshot: request.preparedReview?.candidate.snapshot,
      },
      () => {
        assertRequester();
        if (!params.placements.validateTurnClaim(request.claim)) {
          throw new Error("GitHub publication turn authority changed before recording.");
        }
        resolveGitHubPublicationWorktreeOwner({
          sessionId: request.claim.sessionId,
          sessionKey: request.sessionKey,
          agentId: request.agentId,
          lifecycleRevision: admitted.loaded.entry?.lifecycleRevision ?? null,
          expected: {
            worktreeId: worktree.id,
            repositoryFingerprint: worktree.repoFingerprint,
            branch: worktree.branch,
          },
        });
      },
      request.preparedReview,
    );
    if (request.preparedReview && row.status !== "published" && row.status !== "failed") {
      reviews.retain(row.request_id, request.preparedReview, request.claim);
    }
    return publicationResult(row);
  };

  const { bindWorkspaceSnapshot, updatePublishingFacts, complete } =
    createGitHubPublicationExecutionStore(instanceId);

  const bindAcceptedClaimSnapshot = (input: {
    row: PublicationRow;
    claim: WorkerSessionTurnClaim;
    sourceHeadCommit: string;
    sourceIndexTree: string;
    workspaceTree: string;
  }): PublicationRow =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        assertStoredGitHubPublicationClaim(db, {
          claim: input.claim,
          sessionKey: input.row.session_key,
          agentId: input.row.agent_id,
        });
        const query = publicationDb(db);
        const current = readGitHubPublicationRequest(db, { requestId: input.row.request_id });
        if (
          !current ||
          current.claim_id !== input.claim.claimId ||
          current.run_id !== input.claim.runId ||
          (current.status !== "requested" && current.status !== "publishing")
        ) {
          throw new Error("GitHub publication workspace snapshot owner changed.");
        }
        if (current.source_head_commit || current.source_index_tree || current.workspace_tree) {
          if (
            current.source_head_commit !== input.sourceHeadCommit ||
            current.source_index_tree !== input.sourceIndexTree ||
            current.workspace_tree !== input.workspaceTree
          ) {
            throw new Error("GitHub publication accepted workspace snapshot changed.");
          }
          return current;
        }
        const updated = executeSqliteQueryTakeFirstSync(
          db,
          query
            .updateTable("github_publication_requests")
            .set({
              source_head_commit: input.sourceHeadCommit,
              source_index_tree: input.sourceIndexTree,
              workspace_tree: input.workspaceTree,
              updated_at_ms: Date.now(),
            })
            .where("request_id", "=", input.row.request_id)
            .where("source_head_commit", "is", null)
            .where("source_index_tree", "is", null)
            .where("workspace_tree", "is", null)
            .returningAll(),
        );
        if (!updated) {
          throw new Error("GitHub publication accepted workspace snapshot changed.");
        }
        deferSharedGitHubPublicationChanged(db, updated);
        return updated;
      },
      undefined,
      { operationLabel: "github-publication.bind-accepted-workspace" },
    );

  const processRow = (
    initial: PublicationRow,
    validateExecution: () => boolean,
    assertInvocationCurrent?: () => void,
    review?: PreparedGitHubPublicationReview,
  ): Promise<SessionGitHubPublicationResult> => {
    if (initial.status === "published" || initial.status === "failed") {
      return Promise.resolve(publicationResult(initial));
    }
    const executionKey = `${instanceId}\0${initial.request_id}`;
    return getOrCreatePromise(
      activePublicationExecutions,
      executionKey,
      () => {
        const claimed = claimExecution(initial.request_id, instanceId);
        if (claimed.status === "published" || claimed.status === "failed") {
          return Promise.resolve(publicationResult(claimed));
        }
        return params.placements.withWorkspaceExclusion(claimed.session_id, async (assertOwned) => {
          const lease = await acquireWorktreeRunLease(claimed.worktree_id);
          const validateCustody = () => {
            assertOwned();
            return validateExecution() && ownsExecution(claimed.request_id, instanceId);
          };
          let effect: SessionGitHubPublicationResult["effect"];
          let dispatched = false;
          let requester: Awaited<ReturnType<typeof restoreGitHubPublicationRequester>> | undefined;
          const getRequester = () => {
            if (!requester) {
              throw new GitHubPublicationRequesterUnavailableError();
            }
            return requester;
          };
          try {
            assertOwned();
            // Restart and automatic recovery can observe a reviewed request, but an
            // inert candidate never reconstructs the maintainer's confirmation.
            const reviewed = await readGitHubPublicationReview({
              publicationRequestId: claimed.request_id,
            });
            assertOwned();
            const session = loadGatewaySessionEntryReadOnly(claimed.session_key, {
              agentId: claimed.agent_id,
            });
            if ((reviewed || session.entry?.sandbox === "required") && !review) {
              const observed = await reconcileGitHubPublication({
                initial: claimed,
                validateCustody,
                projectResult: publicationResult,
                complete,
              });
              return observed ?? publicationNeedsReviewConfirmation(publicationResult(claimed));
            }
            if (
              review &&
              (reviewed?.review_id !== review.id || reviewed.candidate_digest !== review.digest)
            ) {
              throw new Error("Publication confirmation does not own this receipt.");
            }
            review?.assertCurrent();
            return await executeGitHubPublication({
              review,
              initial: claimed,
              validateCustody,
              prepareAuthority: async () => {
                if (!validateCustody()) {
                  throw new GitHubPublicationAuthorityLostError(
                    "GitHub publication execution custody changed before requester preparation.",
                  );
                }
                const lifecycle = await readGitHubPublicationSessionLifecycleInWorker({
                  publicationKind: "shared",
                  requestId: claimed.request_id,
                }).catch((cause: unknown) => {
                  throw new GitHubPublicationRecoveryPendingError(
                    "GitHub publication requester metadata is unavailable; retry recovery.",
                    { cause },
                  );
                });
                if (!validateCustody()) {
                  throw new GitHubPublicationAuthorityLostError(
                    "GitHub publication execution custody changed during requester preparation.",
                  );
                }
                assertInvocationCurrent?.();
                requester = await restoreGitHubPublicationRequester(
                  lifecycle?.requester_authority_json,
                  { sessionKey: claimed.session_key, agentId: claimed.agent_id },
                  params.getCommittedRuntimeConfig,
                );
              },
              validateAuthority: () => {
                if (!validateCustody()) {
                  return false;
                }
                getRequester().assertCurrent();
                assertInvocationCurrent?.();
                return true;
              },
              projectResult: publicationResult,
              recordEffect: (kind, observed) => {
                dispatched ||= observed === undefined;
                effect = {
                  kind,
                  status: observed?.headCommit || observed?.url ? "observed" : "dispatched",
                  ...observed,
                };
              },
              bindWorkspaceSnapshot,
              updatePublishingFacts,
              complete,
              defer: (row) => {
                deferRequests([row.request_id]);
                const deferred = readById(row.request_id);
                if (!deferred) {
                  throw new Error("GitHub publication request disappeared.");
                }
                return deferred;
              },
            });
          } catch (error) {
            if (!(error instanceof GitHubPublicationRequesterUnavailableError)) {
              throw error;
            }
            if (!validateCustody()) {
              throw new GitHubPublicationAuthorityLostError(
                "GitHub publication execution custody changed before reconciliation.",
              );
            }
            const current = await readGitHubPublicationRequestInWorker(claimed.request_id).catch(
              (cause: unknown) => {
                throw new GitHubPublicationRecoveryPendingError(
                  "GitHub publication receipt is unavailable; retry recovery.",
                  { cause },
                );
              },
            );
            if (!current || !validateCustody()) {
              throw new GitHubPublicationAuthorityLostError(
                "GitHub publication execution custody changed during reconciliation.",
              );
            }
            // A fresh execution knows whether it dispatched any GitHub write. Historical
            // head facts still require observation; an absent response proves nothing.
            if (claimed.head_commit !== null || dispatched) {
              const observed = await reconcileGitHubPublication({
                initial: current,
                validateCustody,
                projectResult: publicationResult,
                complete,
                pushOnly:
                  claimed.head_commit === null && effect?.kind === "push"
                    ? effect.status === "observed" && effect.headCommit === current.head_commit
                      ? "observed"
                      : "dispatched"
                    : undefined,
              });
              if (observed) {
                return observed;
              }
            }
            if (!validateCustody()) {
              throw new GitHubPublicationAuthorityLostError(
                "GitHub publication execution custody changed during reconciliation.",
              );
            }
            return publicationResult(
              complete(current, {
                requestId: current.request_id,
                status: "failed",
                ...error.failure,
                message: error.message,
              }),
            );
          } finally {
            requester?.release();
            await lease.release();
          }
        });
      },
      { evictOnSettled: true },
    );
  };

  const prepareClaimWorkspace = async (claim: WorkerSessionTurnClaim): Promise<void> => {
    ensureSchema();
    await params.placements.closeWorkerTurnToolAdmission(claim);
    const rows = listGitHubPublicationsForClaim(claim, { pendingOnly: true });
    if (rows.length === 0) {
      return;
    }
    if (!params.placements.validateWorkspaceResultClaim(claim)) {
      throw new Error("GitHub publication lost its workspace result claim before snapshot.");
    }
    const first = rows[0]!;
    const { worktree } = resolveGitHubPublicationWorktreeOwner({
      sessionId: first.session_id,
      sessionKey: first.session_key,
      agentId: first.agent_id,
      expected: {
        worktreeId: first.worktree_id,
        repositoryFingerprint: first.repository_fingerprint,
        branch: first.branch,
      },
    });
    for (const row of rows) {
      if (!sameWorktree(row, worktree)) {
        throw new Error("GitHub publication worktree changed before accepted snapshot.");
      }
    }
    const bound = rows.find(
      (row) => row.source_head_commit && row.source_index_tree && row.workspace_tree,
    );
    if (bound) {
      for (const row of rows) {
        if (
          (row.source_head_commit || row.source_index_tree || row.workspace_tree) &&
          (row.source_head_commit !== bound.source_head_commit ||
            row.source_index_tree !== bound.source_index_tree ||
            row.workspace_tree !== bound.workspace_tree)
        ) {
          throw new Error("GitHub publication accepted workspace snapshot changed.");
        }
      }
      if (
        rows.every((row) => row.source_head_commit && row.source_index_tree && row.workspace_tree)
      ) {
        return;
      }
    }
    const snapshot = await captureGitHubPublicationWorkspaceSnapshot({
      cwd: worktree.path,
      assertCurrent: () => {
        if (!params.placements.validateWorkspaceResultClaim(claim)) {
          throw new Error("GitHub publication lost its workspace result claim during snapshot.");
        }
      },
    });
    for (const row of rows) {
      bindAcceptedClaimSnapshot({ row, claim, ...snapshot });
    }
  };

  const deferClaimPreparation = (claim: WorkerSessionTurnClaim): void => {
    ensureSchema();
    const rows = listGitHubPublicationsForClaim(claim, { pendingOnly: true });
    deferRequests(rows.map((row) => row.request_id));
  };

  const repository = createRepositoryGitHubPublicationCoordinator({ ...params, reviews });
  const personal = createPersonalGitHubPublicationCoordinator(params.placements);
  const methods = createGitHubPublicationCoordinatorMethods({
    placements: params.placements,
    reviews,
    readById,
    requestForClaim,
    sameWorktree,
    processRow,
  });
  return {
    ...methods,
    ...personal,
    retireReviewReport: retireGitHubPublicationReviewReport,
    reviewResult(review: GitHubPublicationReviewRow) {
      if (!review.publication_request_id) {
        return undefined;
      }
      const id = review.publication_request_id;
      const row =
        readRepositoryGitHubPublication(id) ??
        readById(id) ??
        readPersonalGitHubPublication(review.requester_profile_id, { requestId: id });
      if (
        !row ||
        row.session_id !== review.session_id ||
        row.session_key !== review.session_key ||
        row.agent_id !== review.agent_id
      ) {
        return undefined;
      }
      return publicationResult(row);
    },
    async prepareReview(input: {
      session: PublicationSessionIdentity;
      request: Extract<SessionGitHubReviewParams, { action: "prepare" }>;
      requester: GitHubPublicationRequester;
      prepareIdentity: (assertCurrent: () => void) => Promise<PreparedGitHubPublicationIdentity>;
      expectedRunId?: string;
      signal: AbortSignal;
    }) {
      assertDurableGitHubPublicationReview(input.session.sessionKey);
      input.requester.assertCurrent();
      const profileId =
        input.requester.snapshot.actor.kind === "operator"
          ? input.requester.snapshot.actor.profileId
          : GATEWAY_OWNER_PROFILE_ID;
      const previous = await findGitHubPublicationReview({
        sessionId: input.session.sessionId,
        profileId,
        idempotencyKey: input.request.idempotencyKey,
      });
      input.requester.assertCurrent();
      if (previous) {
        // A lost response must return the reviewed bytes, never recapture newer edits.
        assertGitHubPublicationReviewSession(previous, input.session);
        const candidate = readGitHubPublicationReviewCandidate(previous);
        const selection = input.request.selection;
        if (
          previous.requester_authority_json !==
            encodeGitHubPublicationRequester(input.requester.snapshot) ||
          previous.requested_review_id !== (input.request.requestedReviewId ?? null) ||
          candidate.title !== (input.request.title ?? null) ||
          candidate.body !== (input.request.body ?? null) ||
          candidate.selection.source !== (selection?.source ?? "shared") ||
          (selection?.source === "personal" &&
            (candidate.selection.source !== "personal" ||
              candidate.selection.generation !== selection.generation ||
              candidate.selection.account.accountId !== selection.account.accountId))
        ) {
          throw new Error("Publication review idempotency key was reused; start a new review.");
        }
        if (selection?.source === "shared") {
          assertExpectedSharedGitHubPublisher(selection.expected, {
            source: candidate.publisher.source,
            accountId: candidate.publisher.accountId,
            login: candidate.publisher.login,
          });
        }
        input.requester.assertCurrent();
        return previous;
      }
      const placement = params.placements.get(input.session.sessionId);
      const claim = placement ? exactClaimForPlacement(placement) : undefined;
      if (input.expectedRunId && input.expectedRunId !== claim?.runId) {
        throw new Error("Publication review lost its original maintainer turn.");
      }
      const candidate = await captureGitHubPublicationReview({
        ...input,
        placements: params.placements,
        assertCurrent: input.requester.assertCurrent,
        claim: input.expectedRunId ? claim : undefined,
      });
      input.requester.assertCurrent();
      return insertGitHubPublicationReview({
        session: input.session,
        idempotencyKey: input.request.idempotencyKey,
        profileId,
        requestedReviewId: input.request.requestedReviewId,
        reviewed: { candidate, requester: input.requester.snapshot },
        assertCurrent: input.requester.assertCurrent,
      });
    },
    requestForClaim: async (request: GitHubPublicationClaimRequest) =>
      (
        await prepareGitHubPublicationWorkspaceOwner({
          sessionId: request.claim.sessionId,
          sessionKey: request.sessionKey,
          agentId: request.agentId,
        })
      )().kind === "repository"
        ? repository.requestForClaim(request)
        : requestForClaim(request),
    async prepareClaimWorkspace(claim: WorkerSessionTurnClaim) {
      await prepareClaimWorkspace(claim);
      await repository.prepareClaimWorkspace(claim);
    },
    deferClaimPreparation(claim: WorkerSessionTurnClaim) {
      deferClaimPreparation(claim);
      repository.deferClaimPreparation(claim);
    },
    requestForSession(input: Parameters<typeof methods.requestForSession>[0]) {
      const loaded = loadGatewaySessionEntryReadOnly(input.sessionKey!, { agentId: input.agentId });
      return loaded.entry?.repositoryWorkspaceId
        ? repository.requestForSession(input)
        : methods.requestForSession(input);
    },
    async requestPersonalForSession(
      ...args: Parameters<typeof personal.requestPersonalForSession>
    ) {
      return (await prepareGitHubPublicationWorkspaceOwner(args[1]))().kind === "repository"
        ? repository.requestPersonalForSession(...args)
        : personal.requestPersonalForSession(...args);
    },
    async sharedStatus(...args: Parameters<typeof methods.sharedStatus>) {
      return (await repository.sharedStatus(...args)) ?? (await methods.sharedStatus(...args));
    },
    async latestShared(...args: Parameters<typeof methods.latestShared>) {
      return (await repository.latestShared(...args)) ?? (await methods.latestShared(...args));
    },
    preparePersonalStatus: repository.preparePersonalStatus,
    personalStatus(...args: Parameters<typeof repository.personalStatus>) {
      return repository.hasRequest(args[2])
        ? repository.personalStatus(...args)!
        : personal.personalStatus(args[0], args[1], args[2]);
    },
    async personalPending(...args: Parameters<typeof personal.personalPending>) {
      return (await repository.personalPending(...args)) ?? personal.personalPending(...args);
    },
    confirmPersonal(...args: Parameters<typeof personal.confirmPersonal>) {
      return repository.hasRequest(args[0].requestId)
        ? repository.confirmPersonal(...args)
        : personal.confirmPersonal(...args);
    },
    async processClaim(claim: WorkerSessionTurnClaim) {
      return [...(await methods.processClaim(claim)), ...(await repository.processClaim(claim))];
    },
    async resumeSessionRequests() {
      const failures: unknown[] = [];
      for (const coordinator of [methods, repository]) {
        try {
          await coordinator.resumeSessionRequests();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          failures
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join("; "),
        );
      }
    },
    deferOrphanedRequests() {
      methods.deferOrphanedRequests();
      repository.deferOrphanedRequests();
    },
    async listUnreportedResults() {
      return [
        ...methods.listUnreportedResults(),
        ...repository.listUnreportedResults(),
        ...(await listUnreportedGitHubPublicationReviews()).map((row) => ({
          sessionId: row.session_id,
          sessionKey: row.session_key,
          agentId: row.agent_id,
          lifecycleRevision: row.lifecycle_revision,
          result: {
            requestId: row.review_id,
            status: "requested" as const,
            message: projectGitHubPublicationReview(row).message,
          },
        })),
      ];
    },
    read(requestId: string) {
      return repository.read(requestId) ?? methods.read(requestId);
    },
    async markReported(requestId: string) {
      await markGitHubPublicationReviewReported(requestId);
      methods.markReported(requestId);
      repository.markReported(requestId);
    },
  };
}
