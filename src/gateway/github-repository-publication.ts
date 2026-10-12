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
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import type { PersonalGitHubAction } from "./github-personal-oauth.js";
import {
  assertPersonalGitHubPublicationReplay,
  bindPersonalGitHubPublicationSelection,
  preparePersonalRepositoryPublicationStatus as preparePersonalStatus,
  presentPersonalGitHubPublicationStatus,
  preparePersonalGitHubPublicationSelection,
  type PersonalGitHubSessionActionV2,
  type PreparedRepositoryPublicationStatus,
} from "./github-personal-publication.js";
import {
  assertExpectedSharedGitHubPublisher,
  prepareCurrentGitHubPublicationIdentity,
  sameGitHubPublicationWorkspace,
  type PublicationSessionIdentity as SessionIdentity,
} from "./github-publication-availability.js";
import {
  exactClaimForPlacement,
  createSharedGitHubPublicationReadMethods,
  type GitHubPublicationClaimRequestV2,
  type GitHubPublicationSessionRequestV2,
} from "./github-publication-coordinator-methods.js";
import {
  matchesGitHubPublicationIdentityRow,
  projectGitHubPublicationResult,
} from "./github-publication-receipt.js";
import { insertRepositoryGitHubPublicationAsync } from "./github-publication-request-async.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import {
  listRepositoryGitHubPublicationsAsync,
  readRepositoryGitHubPublicationBranchAsync,
  readRepositoryGitHubPublicationAsync,
} from "./github-publication-store-async.js";
import { createRepositoryGitHubPublicationExecution } from "./github-repository-publication-execution.js";
import { prepareRepositoryGitHubPublicationTarget } from "./github-repository-publication-executor.js";
import { createRepositoryGitHubPublicationRecovery } from "./github-repository-publication-recovery.js";
import {
  readPendingRepositoryGitHubPublication,
  repositoryGitHubPublicationDigest,
  terminalRepositoryGitHubPublication,
} from "./github-repository-publication-store.js";
import { prepareRepositoryOwner } from "./github-repository-publication-workspace.js";
import { matchesRepositoryGitHubPublicationClaim } from "./github-repository-publication.kernel.js";
import type { RepositoryGitHubPublicationStatusRow } from "./github-repository-publication.kernel.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { resolvePlacementTurnEnvironment } from "./worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export function createRepositoryGitHubPublicationCoordinator(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  signal: AbortSignal;
}) {
  const { placements, getCommittedRuntimeConfig } = params;
  const prepareSource = async (
    requester: Pick<GitHubPublicationRequesterPolicyV2, "prepareSource">,
    selector: Parameters<GitHubPublicationRequesterPolicyV2["prepareSource"]>[0],
  ) => {
    const source = await requester.prepareSource(selector);
    try {
      params.assertCurrent();
      return bindGitHubPublicationSourceLifetime(source, params.signal);
    } catch (error) {
      await source.release();
      throw error;
    }
  };
  const instanceId = placements.workspaceResultInstanceId();
  const active = new Map<string, string>();
  const personalStatus = (
    row: RepositoryGitHubPublicationStatusRow,
    action: PersonalGitHubAction,
    session: SessionIdentity,
    prepared: PreparedRepositoryPublicationStatus | undefined,
  ) =>
    presentPersonalGitHubPublicationStatus(
      { kind: "repository", row, prepared },
      action,
      session,
      row.execution_id !== null &&
        row.gateway_instance_id === instanceId &&
        active.get(row.request_id) === row.execution_id,
    );
  const execute = createRepositoryGitHubPublicationExecution({
    instanceId,
    active,
    prepareSource,
    getCommittedRuntimeConfig,
    assertCurrent: params.assertCurrent,
  });
  const makeRow = async (input: {
    session: SessionIdentity;
    workspace: SessionRepositoryWorkspaceRecord;
    request: { idempotencyKey: string; title?: string; body?: string };
    identity: PreparedGitHubPublicationIdentity;
    target: Awaited<ReturnType<typeof prepareRepositoryGitHubPublicationTarget>>;
    action?: PersonalGitHubSessionActionV2;
    generation?: string;
    claim?: WorkerSessionTurnClaim;
    requesterAuthorityJson: string | null;
  }): Promise<RepositoryGitHubPublicationRow> => {
    const { head: previous } = await readRepositoryGitHubPublicationBranchAsync({
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
      checkpoint_ref: null,
      checkpoint_digest: null,
      source_head_commit: null,
      source_index_tree: null,
      workspace_tree: null,
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
  const admitShared = async (
    input: GitHubPublicationSessionRequestV2,
    claim?: WorkerSessionTurnClaim,
  ) => {
    const requester = input.requester;
    requester.assertCurrent();
    const requesterAuthorityJson = encodeGitHubPublicationRequester(requester.snapshot);
    if (!input.sessionKey) {
      throw new Error("GitHub publication requires an authoritative session.");
    }
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getCommittedRuntimeConfig(),
      key: input.sessionKey,
      agentId: input.agentId,
      assertActive: params.assertCurrent,
    });
    requester.assertCurrent();
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
    const assertCurrent = () => {
      requester.assertCurrent();
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
    const [existing] = await listRepositoryGitHubPublicationsAsync({
      sessionId: session.sessionId,
      idempotencyKey: input.idempotencyKey,
      ownerProfileId: null,
    });
    assertCurrent();
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
        : { idempotencyKey: input.idempotencyKey, hasRequest: () => Boolean(existing) },
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
    const row = await makeRow({
      session,
      workspace: initial.workspace,
      request: input,
      identity,
      target,
      claim,
      requesterAuthorityJson,
    });
    const source = await prepareSource(requester, {
      ...session,
      repositoryWorkspaceId: row.workspace_id,
      repositoryBranch: row.branch,
    });
    try {
      assertCurrent();
      return await insertRepositoryGitHubPublicationAsync(row, source);
    } finally {
      await source.release();
    }
  };
  return {
    async requestForClaimV2(input: GitHubPublicationClaimRequestV2) {
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
      return projectGitHubPublicationResult(row);
    },
    async requestForSessionV2(input: GitHubPublicationSessionRequestV2) {
      if (input.selection?.source === "personal") {
        throw new Error("My GitHub publication requires direct personal authorization.");
      }
      const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getCommittedRuntimeConfig(),
        key: input.sessionKey!,
        agentId: input.agentId,
        assertActive: params.assertCurrent,
      });
      const placement = loaded.entry?.sessionId
        ? await placements.getAsync(loaded.entry.sessionId)
        : undefined;
      input.requester.assertCurrent();
      const currentClaim = placement ? exactClaimForPlacement(placement) : undefined;
      if (input.expectedRunId !== undefined && input.expectedRunId !== currentClaim?.runId) {
        throw new Error("GitHub publication run identity changed.");
      }
      const claim = input.expectedRunId !== undefined ? currentClaim : undefined;
      const row = await admitShared(input, claim);
      if (
        terminalRepositoryGitHubPublication(row) ||
        claim ||
        (await placements.getAsync(row.session_id))?.turnClaim
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
            requester: input.requester,
          }),
      );
    },
    async requestPersonalForSessionV2(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionActionV2,
    ) {
      if (input.selection?.source !== "personal" || input.idempotencyKey.length > 128) {
        throw new Error("My GitHub publication requires an explicit bounded account selection.");
      }
      const selected = input.selection;
      action.assertCurrent();
      const [existing] = await listRepositoryGitHubPublicationsAsync({
        sessionId: action.sessionId,
        idempotencyKey: input.idempotencyKey,
        ownerProfileId: action.owner,
      });
      action.assertCurrent();
      if (existing) {
        assertPersonalGitHubPublicationReplay(existing, input, selected);
        const prepared = await preparePersonalStatus(existing.request_id);
        action.assertCurrent();
        return personalStatus(existing, action, action, prepared).result;
      }
      const bound = bindPersonalGitHubPublicationSelection(action, selected, {
        idempotencyKey: input.idempotencyKey,
        hasRequest: () => Boolean(existing),
      });
      return await placements.withRepositoryWorkspaceReservation(
        action,
        async (assertReservation) => {
          const currentOwner = await prepareRepositoryOwner(action);
          const initial = currentOwner();
          const assertCurrent = () => {
            action.assertCurrent();
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
          const candidate = await makeRow({
            session: action,
            workspace: initial.workspace,
            request: input,
            identity,
            target,
            action,
            generation: selected.generation,
            requesterAuthorityJson: null,
          });
          const source = await prepareSource(action, {
            agentId: action.agentId,
            sessionKey: action.sessionKey,
            sessionId: action.sessionId,
            lifecycleRevision: action.lifecycleRevision,
            personalOwnerProfileId: action.owner,
            repositoryWorkspaceId: candidate.workspace_id,
            repositoryBranch: candidate.branch,
          });
          let row: RepositoryGitHubPublicationRow;
          try {
            assertCurrent();
            row = await insertRepositoryGitHubPublicationAsync(candidate, source);
          } finally {
            await source.release();
          }
          return await execute(row, { assertCustody: assertReservation, assertCurrent, action });
        },
      );
    },
    async processClaim(claim: WorkerSessionTurnClaim) {
      const results = [];
      for (const row of (
        await listRepositoryGitHubPublicationsAsync({
          sessionId: claim.sessionId,
          ownerProfileId: null,
          pending: true,
        })
      ).filter(
        (candidate) =>
          candidate.claim_id === null || matchesRepositoryGitHubPublicationClaim(candidate, claim),
      )) {
        await placements.prepareWorkspaceResultClaim(claim);
        results.push(
          await placements.withWorkspaceExclusion(
            row.session_id,
            async (assertOwned) =>
              await execute(row, {
                assertCustody: () => {
                  assertOwned();
                  if (!placements.validateWorkspaceResultClaim(claim)) {
                    throw new Error("GitHub publication lost its workspace result claim.");
                  }
                },
              }),
          ),
        );
      }
      return results;
    },
    ...createRepositoryGitHubPublicationRecovery({
      placements,
      getCommittedRuntimeConfig,
      assertCurrent: params.assertCurrent,
      isExecuting: (requestId) => active.has(requestId),
      execute: (row, assertCustody) => execute(row, { assertCustody }),
    }),
    ...createSharedGitHubPublicationReadMethods("repository"),
    preparePersonalStatus,
    async personalStatusAsync(
      action: PersonalGitHubAction,
      session: SessionIdentity,
      requestId: string,
      prepared: PreparedRepositoryPublicationStatus | undefined,
    ) {
      const row = await readRepositoryGitHubPublicationAsync(requestId);
      params.assertCurrent();
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
      action.assertCurrent();
      return personalStatus(row, action, session, prepared);
    },
    async confirmPersonalV2(
      input: SessionGitHubConfirmParams,
      action: PersonalGitHubSessionActionV2,
    ) {
      action.assertCurrent();
      const row = await readRepositoryGitHubPublicationAsync(input.requestId);
      action.assertCurrent();
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
          }),
      );
    },
    async readAsync(requestId: string) {
      const row = await readRepositoryGitHubPublicationAsync(requestId);
      params.assertCurrent();
      return row && row.owner_profile_id === null ? projectGitHubPublicationResult(row) : undefined;
    },
    async hasRequestAsync(requestId: string) {
      const row = await readRepositoryGitHubPublicationAsync(requestId);
      params.assertCurrent();
      return Boolean(row);
    },
    async listUnreportedResultsAsync() {
      const rows = await listRepositoryGitHubPublicationsAsync({
        pending: false,
        unreported: true,
      });
      params.assertCurrent();
      return rows.map((row) => ({
        sessionId: row.session_id,
        sessionKey: row.session_key,
        agentId: row.agent_id,
        result: projectGitHubPublicationResult(row),
      }));
    },
  };
}
