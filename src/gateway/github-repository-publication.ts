import { randomUUID } from "node:crypto";
import type {
  SessionGitHubConfirmParams,
  SessionGitHubPublishParams,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import {
  decodeGitHubPublicationRequester,
  encodeGitHubPublicationRequester,
  matchesGitHubPublicationRequester,
} from "../state/github-publication-requester.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import type { PersonalGitHubAction } from "./github-personal-oauth.js";
import {
  assertPersonalGitHubPublicationReplay,
  bindPersonalGitHubPublicationSelection,
  createPersonalRepositoryPublicationStatusReader,
  preparePersonalGitHubPublicationSelection,
  type PersonalGitHubSessionAction,
  type PreparedRepositoryPublicationStatus,
} from "./github-personal-publication.js";
import { insertRepositoryGitHubPublication } from "./github-publication-admission.js";
import {
  assertExpectedSharedGitHubPublisher,
  prepareCurrentGitHubPublicationIdentity,
  sameGitHubPublicationWorkspace,
  type PublicationSessionIdentity as SessionIdentity,
} from "./github-publication-availability.js";
import {
  exactClaimForPlacement,
  createSharedGitHubPublicationReadMethods,
  type GitHubPublicationClaimRequest,
  type GitHubPublicationSessionRequest as SharedRequest,
} from "./github-publication-coordinator-methods.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { restoreGitHubPublicationRequester } from "./github-publication-requester.js";
import {
  assertGitHubPublicationReviewSnapshot,
  type PreparedGitHubPublicationReview,
} from "./github-publication-review-contract.js";
import { readGitHubPublicationReview } from "./github-publication-review-store.js";
import {
  requireGitHubPublicationReview,
  publicationNeedsReviewConfirmation,
  type createGitHubPublicationReviewHolds,
} from "./github-publication-review.js";
import {
  matchesGitHubPublicationIdentityRow,
  projectGitHubPublicationResult,
} from "./github-publication-store.js";
import {
  executeRepositoryGitHubPublication,
  prepareRepositoryGitHubPublicationTarget,
} from "./github-repository-publication-executor.js";
import {
  createRepositoryGitHubPublicationRecovery,
  matchesRepositoryGitHubPublicationClaim,
  settleDeniedRepositoryGitHubPublication,
  reconcileRepositoryGitHubPublication,
} from "./github-repository-publication-recovery.js";
import { readGitHubRepositoryPublicationMetadata } from "./github-repository-publication-snapshot.js";
import {
  bindRepositoryGitHubPublicationCheckpoint,
  claimRepositoryGitHubPublication,
  listRepositoryGitHubPublications,
  readRepositoryGitHubPublicationBranch,
  markRepositoryGitHubPublicationReported,
  readRepositoryGitHubPublication,
  readPendingRepositoryGitHubPublication,
  requireRepositoryGitHubPublication,
  repositoryGitHubPublicationDigest,
  terminalRepositoryGitHubPublication,
  type RepositoryGitHubPublicationExecution,
} from "./github-repository-publication-store.js";
import {
  prepareRepositoryOwner,
  assertReceiptOwner,
  captureCheckpoint,
  type PreparedRepositoryPublicationSnapshot,
} from "./github-repository-publication-workspace.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { resolvePlacementTurnEnvironment } from "./worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";
import { withSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";

export function createRepositoryGitHubPublicationCoordinator(params: {
  placements: WorkerSessionPlacementStore;
  reviews: ReturnType<typeof createGitHubPublicationReviewHolds>;
  getCommittedRuntimeConfig: () => OpenClawConfig;
}) {
  const { placements, getCommittedRuntimeConfig } = params;
  const instanceId = placements.workspaceResultInstanceId();
  const active = new Map<string, string>();
  const requestByKey = (sessionId: string, key: string, owner: string | null) =>
    listRepositoryGitHubPublications({ sessionId, idempotencyKey: key, ownerProfileId: owner })[0];
  const { preparePersonalStatus, personalStatus } = createPersonalRepositoryPublicationStatusReader(
    (row) =>
      row.execution_id !== null &&
      row.gateway_instance_id === instanceId &&
      active.get(row.request_id) === row.execution_id,
  );
  const execute = async (
    initial: RepositoryGitHubPublicationRow,
    context: {
      assertCustody: () => void;
      assertCurrent?: () => void;
      action?: PersonalGitHubSessionAction;
      review?: PreparedGitHubPublicationReview;
    },
  ) => {
    let row = requireRepositoryGitHubPublication(initial.request_id);
    if (terminalRepositoryGitHubPublication(row)) {
      return projectGitHubPublicationResult(row);
    }
    const { assertCustody, action, review } = context;
    assertCustody();
    const reviewed = await readGitHubPublicationReview({ publicationRequestId: row.request_id });
    assertCustody();
    const session = loadGatewaySessionEntryReadOnly(row.session_key, { agentId: row.agent_id });
    if (!review && (reviewed || session.entry?.sandbox === "required")) {
      // Personal recovery needs a fresh human selection. Shared observation must
      // never prepare its Gateway account for a receipt owned by a personal account.
      if (row.owner_profile_id !== null) {
        return publicationNeedsReviewConfirmation(projectGitHubPublicationResult(row));
      }
      const observer = claimRepositoryGitHubPublication(row, instanceId, {
        assertCustody,
        assertCurrent: assertCustody,
      });
      const observed = await reconcileRepositoryGitHubPublication({
        execution: observer,
        assertCustody,
      });
      return (
        observed ??
        publicationNeedsReviewConfirmation(projectGitHubPublicationResult(observer.interrupt()))
      );
    }
    if (
      review &&
      (reviewed?.review_id !== review.id || reviewed.candidate_digest !== review.digest)
    ) {
      throw new Error("Publication confirmation does not own this receipt.");
    }
    review?.assertCurrent();
    const preparedOwner = await getSessionRepositoryWorkspaceStore().prepare(row.workspace_id);
    assertCustody();
    row = requireRepositoryGitHubPublication(initial.request_id);
    if (terminalRepositoryGitHubPublication(row)) {
      return projectGitHubPublicationResult(row);
    }
    const { loaded } = assertReceiptOwner(row, preparedOwner);
    const bound =
      action && row.connection_generation
        ? bindPersonalGitHubPublicationSelection(action, {
            generation: row.connection_generation,
            account: { accountId: row.identity_account_id, login: row.identity_login },
          })
        : undefined;
    if (
      (row.owner_profile_id !== null) !== Boolean(bound) ||
      (bound && bound.profileId !== row.identity_profile_id)
    ) {
      throw new Error("My GitHub publication owner changed.");
    }
    let requester: Awaited<ReturnType<typeof restoreGitHubPublicationRequester>> | undefined;
    const getRequester = () => {
      if (!requester) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      return requester;
    };
    const assertExecution = () => {
      // Classify source loss before personal preparation can turn it into a retryable error.
      assertReceiptOwner(row, preparedOwner);
      assertCustody();
      if (row.owner_profile_id === null) {
        getRequester().assertCurrent();
      }
      context.assertCurrent?.();
      review?.assertCurrent();
      bound?.assertCurrent();
    };
    let execution: RepositoryGitHubPublicationExecution | undefined;
    const claimExecution = () => {
      if (!execution) {
        execution = claimRepositoryGitHubPublication(row, instanceId, {
          assertCustody,
          assertCurrent: assertExecution,
        });
        active.set(row.request_id, execution.row.execution_id!);
      }
      return execution;
    };
    const publish = async (captured: PreparedRepositoryPublicationSnapshot) => {
      assertExecution();
      if (
        captured.checkpointRef !== row.checkpoint_ref ||
        captured.digest !== row.checkpoint_digest
      ) {
        throw new Error("GitHub publication accepted checkpoint changed.");
      }
      return await executeRepositoryGitHubPublication({
        review,
        execution: claimExecution(),
        snapshot: captured.snapshot,
        snapshotRoot: captured.snapshotRoot,
        storePath: loaded.storePath,
        assertWorkspace: () => {
          assertReceiptOwner(row, preparedOwner);
        },
        validateAuthority: () => {
          assertExecution();
          return true;
        },
        ...(bound
          ? {
              identity: {
                prepare: () => preparePersonalGitHubPublicationSelection(bound, assertExecution),
                isCurrent: (identity: PreparedGitHubPublicationIdentity) => {
                  assertExecution();
                  return (
                    identity.source === "personal" &&
                    identity.profileId === bound.profileId &&
                    identity.account.accountId === row.identity_account_id
                  );
                },
              },
            }
          : {}),
      });
    };
    try {
      if (row.owner_profile_id === null) {
        requester = await restoreGitHubPublicationRequester(
          row.requester_authority_json,
          { sessionKey: row.session_key, agentId: row.agent_id },
          getCommittedRuntimeConfig,
        );
      }
      assertExecution();
      if (review) {
        const accepted = review.candidate.workspace;
        if (
          accepted.kind !== "repository" ||
          row.workspace_id !== accepted.id ||
          row.checkpoint_ref !== accepted.checkpointRef ||
          row.checkpoint_digest !== accepted.checkpointDigest
        ) {
          throw new Error("The original reviewed checkpoint is missing. Prepare a new candidate.");
        }
        // Own-turn completion may advance checkpoint metadata. It must retain the
        // full reviewed source identity; publication still reads the original checkpoint.
        const currentCheckpoint = await captureCheckpoint(row, assertExecution, async (facts) => {
          assertGitHubPublicationReviewSnapshot(review, {
            sourceHeadCommit: facts.source_head_commit!,
            sourceIndexTree: facts.source_index_tree!,
            workspaceTree: facts.workspace_tree!,
          });
        });
        if (currentCheckpoint) {
          return currentCheckpoint;
        }
      }
      if (!row.checkpoint_ref) {
        if (
          row.owner_profile_id === null &&
          !assertReceiptOwner(row, preparedOwner).workspace.checkpointRef
        ) {
          return projectGitHubPublicationResult(row);
        }
        return await captureCheckpoint(row, assertExecution, async (facts, prepared) => {
          row = bindRepositoryGitHubPublicationCheckpoint(row, facts, assertExecution);
          return await publish(prepared);
        });
      }
      return await withSessionRepositoryCheckpoint(
        {
          workspaceId: row.workspace_id,
          checkpointRef: row.checkpoint_ref,
          includePublication: true,
        },
        async (payload) => {
          assertExecution();
          if (
            !payload.publicationStagingRoot ||
            !payload.publicationDigest ||
            payload.publicationDigest !== row.checkpoint_digest
          ) {
            throw new Error("GitHub publication accepted checkpoint is unavailable.");
          }
          const { snapshot } = await readGitHubRepositoryPublicationMetadata(
            payload.publicationStagingRoot,
            payload.publicationDigest,
          );
          return await publish({
            snapshot,
            snapshotRoot: payload.publicationStagingRoot,
            checkpointRef: row.checkpoint_ref!,
            digest: payload.publicationDigest,
          });
        },
      );
    } catch (error) {
      if (
        row.owner_profile_id === null &&
        error instanceof GitHubPublicationRequesterUnavailableError
      ) {
        return await settleDeniedRepositoryGitHubPublication({
          execution: claimExecution(),
          assertCustody,
          error,
        });
      }
      if (execution?.ownsExecution()) {
        execution.interrupt();
      }
      throw error;
    } finally {
      requester?.release();
      if (execution) {
        active.delete(row.request_id);
      }
    }
  };
  const makeRow = (input: {
    session: SessionIdentity;
    workspace: SessionRepositoryWorkspaceRecord;
    request: { idempotencyKey: string; title?: string; body?: string };
    identity: PreparedGitHubPublicationIdentity;
    target: Awaited<ReturnType<typeof prepareRepositoryGitHubPublicationTarget>>;
    action?: PersonalGitHubSessionAction;
    generation?: string;
    claim?: WorkerSessionTurnClaim;
    requesterAuthorityJson: string | null;
    review?: PreparedGitHubPublicationReview;
  }): RepositoryGitHubPublicationRow => {
    const { head: previous } = readRepositoryGitHubPublicationBranch({
      workspaceId: input.workspace.workspaceId,
      branch: input.workspace.branch,
      pushRepository: input.target.pushRepository,
    });
    const now = Date.now();
    const row: RepositoryGitHubPublicationRow = {
      request_id: randomUUID(),
      idempotency_key: input.request.idempotencyKey,
      request_digest: "",
      session_id: input.session.sessionId,
      session_lifecycle_revision: input.session.lifecycleRevision ?? null,
      session_key: input.session.sessionKey,
      agent_id: input.session.agentId,
      workspace_id: input.workspace.workspaceId,
      owner_profile_id: input.action?.owner ?? null,
      connection_generation: input.generation ?? null,
      identity_source: input.identity.source,
      identity_profile_id: input.identity.profileId ?? null,
      identity_account_id: input.identity.account.accountId,
      identity_login: input.identity.account.login,
      requester_authority_json: input.requesterAuthorityJson,
      title: input.request.title ?? null,
      body: input.request.body ?? null,
      push_repository: input.target.pushRepository,
      repository: input.target.repository,
      base_branch: input.target.baseBranch,
      branch: input.workspace.branch,
      previous_head_commit: previous?.pushed_head_commit ?? null,
      claim_id: input.claim?.claimId ?? null,
      run_id: input.claim?.runId ?? null,
      environment_id: input.claim?.owner.environmentId ?? null,
      owner_epoch: input.claim?.owner.ownerEpoch ?? null,
      placement_generation: input.claim?.placementGeneration ?? null,
      checkpoint_ref:
        input.review?.candidate.workspace.kind === "repository"
          ? input.review.candidate.workspace.checkpointRef
          : null,
      checkpoint_digest:
        input.review?.candidate.workspace.kind === "repository"
          ? input.review.candidate.workspace.checkpointDigest
          : null,
      source_head_commit: input.review?.candidate.snapshot.sourceHeadCommit ?? null,
      source_index_tree: input.review?.candidate.snapshot.sourceIndexTree ?? null,
      workspace_tree: input.review?.candidate.snapshot.workspaceTree ?? null,
      status: "requested",
      execution_id: null,
      gateway_instance_id: null,
      head_commit: null,
      pushed_head_commit: null,
      pull_request_url: null,
      last_effect: null,
      effect_state: null,
      error_code: null,
      next_action: null,
      created_at_ms: now,
      updated_at_ms: now,
      reported_at_ms: null,
    };
    row.request_digest = repositoryGitHubPublicationDigest(row);
    return row;
  };
  const admitShared = async (input: SharedRequest, claim?: WorkerSessionTurnClaim) => {
    const requester = input.requester;
    requester.assertCurrent();
    const requesterAuthorityJson = encodeGitHubPublicationRequester(requester.snapshot);
    if (!input.sessionKey) {
      throw new Error("GitHub publication requires an authoritative session.");
    }
    const loaded = loadGatewaySessionEntryReadOnly(input.sessionKey, { agentId: input.agentId });
    if (!loaded.entry?.sessionId) {
      throw new Error("GitHub publication session changed.");
    }
    const session = {
      sessionId: loaded.entry.sessionId,
      lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
      sessionKey: loaded.canonicalKey,
      agentId: input.agentId,
    };
    const currentOwner = await prepareRepositoryOwner(session);
    const initial = currentOwner();
    requireGitHubPublicationReview({
      sandbox: initial.loaded.entry?.sandbox,
      requester,
      review: input.preparedReview,
    });
    const assertCurrent = () => {
      requester.assertCurrent();
      input.preparedReview?.assertCurrent();
      const placement = claim ? placements.get(session.sessionId) : undefined;
      if (
        !sameGitHubPublicationWorkspace(initial, currentOwner()) ||
        (claim &&
          (!placement ||
            claim.sessionId !== session.sessionId ||
            placement.agentId !== session.agentId ||
            placement.sessionKey !== session.sessionKey ||
            !resolvePlacementTurnEnvironment(placement, claim)))
      ) {
        throw new Error("GitHub publication session authority changed.");
      }
    };
    assertCurrent();
    const existing = requestByKey(session.sessionId, input.idempotencyKey, null);
    if (
      existing &&
      (existing.workspace_id !== initial.workspace.workspaceId ||
        existing.title !== (input.title ?? null) ||
        existing.body !== (input.body ?? null))
    ) {
      throw new Error("GitHub publication idempotency key was reused.");
    }
    const expected = input.selection?.source === "shared" ? input.selection.expected : undefined;
    if (existing && terminalRepositoryGitHubPublication(existing)) {
      const result = projectGitHubPublicationResult(existing);
      assertExpectedSharedGitHubPublisher(expected, result.publisher!);
      return existing;
    }
    if (existing) {
      const original = decodeGitHubPublicationRequester(existing.requester_authority_json);
      if (!original || !matchesGitHubPublicationRequester(original, requester.snapshot)) {
        throw new Error("GitHub publication idempotency key was reused by a different requester.");
      }
    }
    const identity = await prepareCurrentGitHubPublicationIdentity(input.agentId);
    assertCurrent();
    assertExpectedSharedGitHubPublisher(
      expected,
      { source: identity.source, ...identity.account },
      existing
        ? undefined
        : {
            idempotencyKey: input.idempotencyKey,
            hasRequest: () => Boolean(requestByKey(session.sessionId, input.idempotencyKey, null)),
          },
    );
    if (existing) {
      if (!matchesGitHubPublicationIdentityRow(existing, identity)) {
        throw new Error("GitHub publication identity changed.");
      }
      return existing;
    }
    const target = await prepareRepositoryGitHubPublicationTarget(
      initial.workspace,
      identity,
      assertCurrent,
    );
    assertCurrent();
    const row = makeRow({
      session,
      workspace: initial.workspace,
      request: input,
      identity,
      target,
      claim,
      requesterAuthorityJson,
      review: input.preparedReview,
    });
    return insertRepositoryGitHubPublication(row, assertCurrent, input.preparedReview);
  };
  return {
    async requestForClaim(input: GitHubPublicationClaimRequest) {
      const expected = input.expectedPublisher;
      if (expected?.source === "personal") {
        throw new Error("My GitHub publication requires direct personal authorization.");
      }
      const row = await admitShared(
        {
          ...input,
          selection: {
            source: "shared",
            ...(expected
              ? {
                  expected: {
                    source: expected.source,
                    accountId: expected.accountId,
                    login: expected.login,
                  },
                }
              : {}),
          },
        },
        input.claim,
      );
      if (input.preparedReview && !terminalRepositoryGitHubPublication(row)) {
        params.reviews.retain(row.request_id, input.preparedReview, input.claim);
      }
      return projectGitHubPublicationResult(row);
    },
    async requestForSession(input: SharedRequest) {
      if (input.selection?.source === "personal") {
        throw new Error("My GitHub publication requires direct personal authorization.");
      }
      const loaded = loadGatewaySessionEntryReadOnly(input.sessionKey!, { agentId: input.agentId });
      const placement = loaded.entry?.sessionId
        ? placements.get(loaded.entry.sessionId)
        : undefined;
      const currentClaim = placement ? exactClaimForPlacement(placement) : undefined;
      if (input.expectedRunId !== undefined && input.expectedRunId !== currentClaim?.runId) {
        throw new Error("GitHub publication run identity changed.");
      }
      const claim = input.expectedRunId !== undefined ? currentClaim : undefined;
      const row = await admitShared(input, claim);
      if (claim && input.preparedReview && !terminalRepositoryGitHubPublication(row)) {
        params.reviews.retain(row.request_id, input.preparedReview, claim);
      }
      if (
        terminalRepositoryGitHubPublication(row) ||
        claim ||
        placements.get(row.session_id)?.turnClaim
      ) {
        return projectGitHubPublicationResult(row);
      }
      return await placements.withRepositoryWorkspaceReservation(
        {
          sessionId: row.session_id,
          sessionKey: row.session_key,
          agentId: row.agent_id,
        },
        async (assertCustody) =>
          await execute(row, {
            assertCustody,
            assertCurrent: input.requester.assertInvocationCurrent,
            review: input.preparedReview,
          }),
      );
    },
    async requestPersonalForSession(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionAction,
      review?: PreparedGitHubPublicationReview,
    ) {
      if (input.selection?.source !== "personal" || input.idempotencyKey.length > 128) {
        throw new Error("My GitHub publication requires an explicit bounded account selection.");
      }
      const selected = input.selection;
      action.assertCurrent();
      const existing = requestByKey(action.sessionId, input.idempotencyKey, action.owner);
      if (existing) {
        assertPersonalGitHubPublicationReplay(existing, input, selected);
        const prepared = await preparePersonalStatus(existing.request_id);
        return personalStatus(
          requireRepositoryGitHubPublication(existing.request_id),
          action,
          action,
          prepared,
        ).result;
      }
      const bound = bindPersonalGitHubPublicationSelection(action, selected, {
        idempotencyKey: input.idempotencyKey,
        hasRequest: () =>
          Boolean(requestByKey(action.sessionId, input.idempotencyKey, action.owner)),
      });
      return await placements.withRepositoryWorkspaceReservation(
        action,
        async (assertReservation) => {
          const currentOwner = await prepareRepositoryOwner(action);
          const initial = currentOwner();
          requireGitHubPublicationReview({ sandbox: initial.loaded.entry?.sandbox, review });
          const assertCurrent = () => {
            action.assertCurrent();
            review?.assertCurrent();
            assertReservation();
            bound.assertCurrent();
            if (!sameGitHubPublicationWorkspace(initial, currentOwner())) {
              throw new Error("My GitHub repository owner changed.");
            }
          };
          assertCurrent();
          const identity = await preparePersonalGitHubPublicationSelection(bound, assertCurrent);
          const target = await prepareRepositoryGitHubPublicationTarget(
            initial.workspace,
            identity,
            assertCurrent,
          );
          const row = await insertRepositoryGitHubPublication(
            makeRow({
              session: action,
              workspace: initial.workspace,
              request: input,
              identity,
              target,
              action,
              generation: selected.generation,
              requesterAuthorityJson: null,
              review,
            }),
            assertCurrent,
            review,
          );
          return await execute(row, {
            assertCustody: assertReservation,
            assertCurrent,
            action,
            review,
          });
        },
      );
    },
    async processClaim(claim: WorkerSessionTurnClaim) {
      const results = [];
      for (const row of listRepositoryGitHubPublications({
        sessionId: claim.sessionId,
        ownerProfileId: null,
        pending: true,
      }).filter(
        (candidate) =>
          candidate.claim_id === null || matchesRepositoryGitHubPublicationClaim(candidate, claim),
      )) {
        results.push(
          await placements.withWorkspaceExclusion(
            row.session_id,
            async (assertOwned) =>
              await execute(row, {
                review: params.reviews.current(row.request_id, claim),
                assertCustody: () => {
                  assertOwned();
                  if (!placements.validateWorkspaceResultClaim(claim)) {
                    throw new Error("GitHub publication lost its workspace result claim.");
                  }
                },
              }).finally(() => params.reviews.release(row.request_id)),
          ),
        );
      }
      return results;
    },
    ...createRepositoryGitHubPublicationRecovery({
      placements,
      getCommittedRuntimeConfig,
      isExecuting: (requestId) => active.has(requestId),
      execute: (row, assertCustody) => execute(row, { assertCustody }),
    }),
    ...createSharedGitHubPublicationReadMethods("repository"),
    preparePersonalStatus,
    personalStatus(
      action: PersonalGitHubAction,
      session: SessionIdentity,
      requestId: string,
      prepared: PreparedRepositoryPublicationStatus | undefined,
    ) {
      const row = readRepositoryGitHubPublication(requestId);
      return row ? personalStatus(row, action, session, prepared) : undefined;
    },
    async personalPending(action: PersonalGitHubAction, session: SessionIdentity) {
      action.assertCurrent();
      const row = await readPendingRepositoryGitHubPublication({
        ownerProfileId: action.owner,
        sessionKey: session.sessionKey,
        agentId: session.agentId,
      });
      if (!row) {
        action.assertCurrent();
        return null;
      }
      const prepared = await preparePersonalStatus(row.request_id);
      return personalStatus(
        requireRepositoryGitHubPublication(row.request_id),
        action,
        session,
        prepared,
      );
    },
    async confirmPersonal(
      input: SessionGitHubConfirmParams,
      action: PersonalGitHubSessionAction,
      review?: PreparedGitHubPublicationReview,
    ) {
      action.assertCurrent();
      const row = readRepositoryGitHubPublication(input.requestId);
      if (
        !row ||
        row.owner_profile_id !== action.owner ||
        row.session_id !== action.sessionId ||
        (!terminalRepositoryGitHubPublication(row) &&
          row.session_lifecycle_revision !== action.lifecycleRevision) ||
        row.session_key !== action.sessionKey ||
        row.agent_id !== action.agentId ||
        row.request_digest !== input.requestDigest ||
        row.connection_generation !== input.generation ||
        row.identity_account_id !== input.account.accountId ||
        row.identity_login.toLowerCase() !== input.account.login.toLowerCase()
      ) {
        throw new Error("My GitHub confirmation no longer matches the original request.");
      }
      if (terminalRepositoryGitHubPublication(row)) {
        return projectGitHubPublicationResult(row);
      }
      if (active.has(row.request_id)) {
        throw new Error("My GitHub publication is still running; wait for its result.");
      }
      if (!row.checkpoint_ref) {
        throw new Error("GitHub publication has no accepted checkpoint.");
      }
      bindPersonalGitHubPublicationSelection(action, input);
      return await placements.withRepositoryWorkspaceReservation(
        action,
        async (assertReservation) =>
          await execute(row, {
            assertCustody: assertReservation,
            assertCurrent: action.assertCurrent,
            action,
            review,
          }),
      );
    },
    read(requestId: string) {
      const row = readRepositoryGitHubPublication(requestId);
      return row && row.owner_profile_id === null ? projectGitHubPublicationResult(row) : undefined;
    },
    hasRequest: (requestId: string) => Boolean(readRepositoryGitHubPublication(requestId)),
    listUnreportedResults: () =>
      listRepositoryGitHubPublications({ pending: false, unreported: true }).map((row) => ({
        sessionId: row.session_id,
        sessionKey: row.session_key,
        agentId: row.agent_id,
        result: projectGitHubPublicationResult(row),
      })),
    markReported: markRepositoryGitHubPublicationReported,
  };
}
