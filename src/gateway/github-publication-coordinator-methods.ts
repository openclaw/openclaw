import { randomUUID } from "node:crypto";
import type {
  GitHubPublicationPublisher,
  SessionGitHubPublicationResult,
  SessionGitHubPublishParams,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { readGitHubPublicationSessionLifecycleInWorker } from "../state/github-publication-session-lifecycles.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { listUnreportedPersonalGitHubPublications } from "./github-personal-publication-store.js";
import {
  assertExpectedSharedGitHubPublisher,
  prepareCurrentGitHubPublicationIdentity,
  readGitHubPublicationWorktreeOwner,
  type PublicationSessionIdentity,
  readGitHubPublicationSession,
} from "./github-publication-availability.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import {
  digestGitHubPublicationRequest as digestRequest,
  projectGitHubPublicationResult as publicationResult,
} from "./github-publication-receipt.js";
import { readGitHubPublicationRequestInWorker } from "./github-publication-recovery.js";
import { insertGitHubPublicationRequestAsync } from "./github-publication-request-async.js";
import {
  isGitHubPublicationRequesterV2,
  type GitHubPublicationRequester,
  type GitHubPublicationRequesterV2,
} from "./github-publication-requester.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import {
  deferGitHubPublicationRequestsAsync,
  listGitHubPublicationsForClaimAsync,
  listSharedGitHubPublicationsAsync,
  listUnreportedPersonalGitHubPublicationsAsync,
  readGitHubPublicationRequestAsync,
} from "./github-publication-store-async.js";
import {
  insertGitHubPublicationRequest,
  ensureGitHubPublicationStore as ensureSchema,
  githubPublicationDatabase as publicationDb,
  hasGitHubPublicationStore as schemaExists,
  markGitHubPublicationReported,
  readGitHubPublicationRequest,
} from "./github-publication-store.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { projectWorkerSessionTurnClaim } from "./worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

/** @deprecated Use GitHubPublicationClaimRequestV2; removed in the next Plugin SDK major. */
export type GitHubPublicationClaimRequest = {
  claim: WorkerSessionTurnClaim;
  sessionKey: string;
  agentId: string;
  idempotencyKey: string;
  title?: string;
  body?: string;
  requester: GitHubPublicationRequester;
  expectedPublisher?: GitHubPublicationPublisher;
};

/** @deprecated Use GitHubPublicationSessionRequestV2; removed in the next Plugin SDK major. */
export type GitHubPublicationSessionRequest = SessionGitHubPublishParams & {
  agentId: string;
  expectedRunId?: string;
  requester: GitHubPublicationRequester;
};

export type GitHubPublicationClaimRequestV2 = Omit<GitHubPublicationClaimRequest, "requester"> & {
  requester: GitHubPublicationRequesterV2;
};
export type GitHubPublicationSessionRequestV2 = Omit<
  GitHubPublicationSessionRequest,
  "requester"
> & { requester: GitHubPublicationRequesterV2 };

export function exactClaimForPlacement(
  placement: NonNullable<ReturnType<WorkerSessionPlacementStore["get"]>>,
): WorkerSessionTurnClaim | undefined {
  const claim = placement.turnClaim;
  if (claim?.owner !== "local") {
    return projectWorkerSessionTurnClaim(placement);
  }
  return {
    sessionId: placement.sessionId,
    claimId: claim.claimId,
    runId: claim.runId,
    placementGeneration: claim.generation,
    owner: {
      kind: "local",
      ...(placement.environmentId ? { environmentId: placement.environmentId } : {}),
      ...(placement.activeOwnerEpoch !== null ? { ownerEpoch: placement.activeOwnerEpoch } : {}),
    },
  };
}

export function createSharedGitHubPublicationReadMethods(
  kind: Parameters<typeof readSharedGitHubPublication>[0],
) {
  return {
    async sharedStatus(
      session: PublicationSessionIdentity,
      requestId: string,
    ): Promise<SessionGitHubStatusResult | undefined> {
      const row = await readSharedGitHubPublication(kind, session, { requestId });
      return row ? { result: publicationResult(row), confirmation: null } : undefined;
    },

    async latestShared(
      session: PublicationSessionIdentity,
      idempotencyKey?: string,
      isSuperseded?: (
        snapshot: Pick<
          PublicationRow,
          "repository" | "branch" | "source_head_commit" | "workspace_tree"
        >,
      ) => Promise<boolean>,
    ): Promise<SessionGitHubStatusResult | null> {
      const row = await readSharedGitHubPublication(kind, session, { idempotencyKey });
      // Discovery offers recovery for current work, not a failure whose accepted
      // snapshot has since been published. Exact-key and by-id history stay intact.
      if (
        row?.status === "failed" &&
        idempotencyKey === undefined &&
        isSuperseded &&
        (await isSuperseded({
          repository: row.repository,
          branch: row.branch,
          source_head_commit: row.source_head_commit,
          workspace_tree: row.workspace_tree,
        }))
      ) {
        return null;
      }
      return row ? { result: publicationResult(row), confirmation: null } : null;
    },
  };
}

export function createGitHubPublicationCoordinatorMethods(params: {
  placements: WorkerSessionPlacementStore;
  assertCurrent: () => void;
  readById: (requestId: string) => PublicationRow | undefined;
  requestForClaim: (
    request: GitHubPublicationClaimRequest,
  ) => Promise<SessionGitHubPublicationResult>;
  requestForClaimV2: (
    request: GitHubPublicationClaimRequestV2,
  ) => Promise<SessionGitHubPublicationResult>;
  getCommittedRuntimeConfig: () => import("../config/types.openclaw.js").OpenClawConfig;
  signal: AbortSignal;
  sameWorktree: (
    row: PublicationRow,
    worktree: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>["worktree"],
  ) => boolean;
  processRow: (
    initial: PublicationRow,
    validateExecution: () => boolean,
    assertInvocationCurrent?: () => void,
    mode?: "worker" | "legacy",
    invocationSignal?: AbortSignal,
  ) => Promise<SessionGitHubPublicationResult>;
}) {
  const { readById, requestForClaim, sameWorktree, processRow } = params;
  const requestForSession = async (
    input: GitHubPublicationSessionRequest,
    workerRequester?: GitHubPublicationRequesterV2,
  ): Promise<SessionGitHubPublicationResult> => {
    if (input.selection?.source === "personal") {
      throw new Error("My GitHub publication requires direct personal authorization.");
    }
    const expected = input.selection?.expected;
    const assertRequester = input.requester.assertCurrent;
    if (!workerRequester) {
      ensureSchema();
    }
    if (!input.sessionKey) {
      throw new Error("GitHub publication requires an authoritative session.");
    }
    assertRequester();
    const initialLoaded = workerRequester
      ? await loadGatewaySessionEntryReadOnlyInWorker({
          cfg: params.getCommittedRuntimeConfig(),
          key: input.sessionKey,
          agentId: input.agentId,
          assertActive: params.assertCurrent,
        })
      : readGitHubPublicationSession(input.sessionKey, { agentId: input.agentId });
    const sessionId = initialLoaded.entry?.sessionId;
    if (!sessionId) {
      throw new Error("GitHub publication session changed.");
    }
    const initialAuthority = await readGitHubPublicationWorktreeOwner({
      sessionId,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
    });
    const loaded = initialAuthority.loaded;
    const lifecycleRevision = loaded.entry?.lifecycleRevision ?? null;
    const session = {
      sessionId,
      sessionKey: loaded.canonicalKey,
      agentId: input.agentId,
      lifecycleRevision,
    };
    const placement = await params.placements.getAsync(sessionId);
    assertRequester();
    const validateLocalExecution = () => {
      const current = params.placements.get(sessionId);
      return (!current || current.state === "local") && !current?.turnClaim;
    };
    const capturePlacement = placement
      ? {
          state: placement.state,
          generation: placement.generation,
          updatedAtMs: placement.updatedAtMs,
        }
      : null;
    const assertCaptureAuthority = () => {
      assertRequester();
      initialAuthority.assertCurrent();
      const current = params.placements.get(sessionId);
      const unchanged = capturePlacement
        ? current?.state === capturePlacement.state &&
          current.generation === capturePlacement.generation &&
          current.updatedAtMs === capturePlacement.updatedAtMs &&
          !current.turnClaim
        : current === undefined;
      if (!unchanged) {
        throw new Error("GitHub publication session authority changed during snapshot.");
      }
    };
    const claim = placement ? exactClaimForPlacement(placement) : undefined;
    if (claim && input.expectedRunId && claim.runId === input.expectedRunId) {
      const claimRequest = {
        expectedPublisher: expected,
        claim,
        sessionKey: loaded.canonicalKey,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        requester: input.requester,
        ...(input.title ? { title: input.title } : {}),
        ...(input.body ? { body: input.body } : {}),
      };
      const accepted = workerRequester
        ? await params.requestForClaimV2({ ...claimRequest, requester: workerRequester })
        : await requestForClaim(claimRequest);
      assertRequester();
      if (placement?.state !== "local") {
        return accepted;
      }
      const row = workerRequester
        ? await readGitHubPublicationRequestInWorker(accepted.requestId)
        : readById(accepted.requestId);
      if (!row) {
        throw new Error("GitHub publication request disappeared.");
      }
      return await processRow(
        row,
        () => params.placements.validateTurnClaim(claim),
        input.requester.assertInvocationCurrent,
        workerRequester ? "worker" : "legacy",
        workerRequester?.signal,
      );
    }
    if (claim && placement?.state === "local") {
      throw new Error(
        input.expectedRunId
          ? "GitHub publication run identity changed."
          : "GitHub publication cannot join another active session turn.",
      );
    }
    const deferred = placement !== undefined && placement.state !== "local";
    const worktreeOwner = await readGitHubPublicationWorktreeOwner({
      sessionId,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
    });
    const { worktree } = worktreeOwner;
    assertRequester();
    const requestDigest = digestRequest({
      sessionId,
      idempotencyKey: input.idempotencyKey,
      title: input.title,
      body: input.body,
    });
    const readRequest = () =>
      readGitHubPublicationRequest(openOpenClawStateDatabase().db, {
        sessionId,
        idempotencyKey: input.idempotencyKey,
      });
    const existing = workerRequester
      ? await readGitHubPublicationRequestAsync({ sessionId, idempotencyKey: input.idempotencyKey })
      : readRequest();
    if (existing) {
      if (existing.request_digest !== requestDigest || !sameWorktree(existing, worktree)) {
        throw new Error("GitHub publication idempotency key was reused.");
      }
      if (existing.status === "published" || existing.status === "failed") {
        const result = publicationResult(existing);
        assertExpectedSharedGitHubPublisher(expected, result.publisher!);
        return result;
      }
      const lifecycle = await readGitHubPublicationSessionLifecycleInWorker({
        publicationKind: "shared",
        requestId: existing.request_id,
      }).catch((cause: unknown) => {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication requester metadata is unavailable; retry the existing request.",
          { cause },
        );
      });
      input.requester.assertInvocationCurrent();
      if (!lifecycle || lifecycle.lifecycle_revision !== lifecycleRevision) {
        return await processRow(
          existing,
          validateLocalExecution,
          input.requester.assertInvocationCurrent,
          workerRequester ? "worker" : "legacy",
          workerRequester?.signal,
        );
      }
    }
    assertRequester();
    const identity = await prepareCurrentGitHubPublicationIdentity(input.agentId);
    assertRequester();
    assertExpectedSharedGitHubPublisher(
      expected,
      { source: identity.source, ...identity.account },
      existing
        ? undefined
        : {
            idempotencyKey: input.idempotencyKey,
            hasRequest: workerRequester ? () => Boolean(existing) : () => Boolean(readRequest()),
          },
    );
    const insertSessionRequest = async (snapshot?: {
      sourceHeadCommit: string;
      sourceIndexTree: string;
      workspaceTree: string;
    }): Promise<PublicationRow> => {
      const now = Date.now();
      const requestId = randomUUID();
      assertRequester();
      if (workerRequester) {
        worktreeOwner.assertCurrent();
        const source = await workerRequester.prepareSource({
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          sessionId,
          lifecycleRevision,
          worktreeId: worktree.id,
        });
        try {
          assertRequester();
          worktreeOwner.assertCurrent();
          if (snapshot) {
            assertCaptureAuthority();
          }
          bindGitHubPublicationSourceLifetime(source, params.signal);
          return await insertGitHubPublicationRequestAsync(
            {
              request: {
                sessionKey: loaded.canonicalKey,
                agentId: input.agentId,
                idempotencyKey: input.idempotencyKey,
                title: input.title,
                body: input.body,
              },
              requestId,
              requestDigest,
              now,
              identity: {
                source: identity.source,
                profileId: identity.profileId,
                account: identity.account,
              },
              worktree: {
                id: worktree.id,
                repoFingerprint: worktree.repoFingerprint,
                branch: worktree.branch,
              },
              sessionId,
              lifecycleRevision,
              requester: input.requester.snapshot,
              snapshot,
            },
            source,
          );
        } finally {
          await source.release();
        }
      }
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          return insertGitHubPublicationRequest(db, {
            request: { ...input, sessionKey: loaded.canonicalKey },
            requestId,
            requestDigest,
            now,
            identity,
            worktree,
            sessionId,
            lifecycleRevision,
            requester: input.requester.snapshot,
            assertCurrent: () => {
              assertRequester();
              worktreeOwner.assertCurrent();
            },
            snapshot,
          });
        },
        undefined,
        { operationLabel: "github-publication.request-session" },
      );
    };
    if (deferred) {
      worktreeOwner.assertCurrent();
      return publicationResult(await insertSessionRequest());
    }
    const current = await params.placements.getAsync(sessionId);
    assertRequester();
    if ((current && current.state !== "local") || current?.turnClaim) {
      throw new Error("GitHub publication session authority changed after verification.");
    }
    const snapshot =
      existing?.source_head_commit && existing.source_index_tree && existing.workspace_tree
        ? {
            sourceHeadCommit: existing.source_head_commit,
            sourceIndexTree: existing.source_index_tree,
            workspaceTree: existing.workspace_tree,
          }
        : await captureGitHubPublicationWorkspaceSnapshot({
            cwd: worktree.path,
            assertCurrent: assertCaptureAuthority,
          });
    assertCaptureAuthority();
    worktreeOwner.assertCurrent();
    const row = await insertSessionRequest(snapshot);
    return await processRow(
      row,
      validateLocalExecution,
      input.requester.assertInvocationCurrent,
      workerRequester ? "worker" : "legacy",
      workerRequester?.signal,
    );
  };

  return {
    /** @deprecated Use requestForSessionV2; removed in the next Plugin SDK major. */
    requestForSession: (input: GitHubPublicationSessionRequest) => requestForSession(input),
    requestForSessionV2: (input: GitHubPublicationSessionRequestV2) => {
      if (!isGitHubPublicationRequesterV2(input.requester)) {
        throw new Error("GitHub publication requires a host-prepared V2 requester.");
      }
      params.assertCurrent();
      return requestForSession(input, input.requester);
    },

    async resumeSessionRequests(): Promise<void> {
      const rows = await listSharedGitHubPublicationsAsync({ claimNull: true, pending: true });
      params.assertCurrent();
      const pending = new Set(
        (await params.placements.listPendingWorkspaceResultsAsync()).map(
          (result) => result.sessionId,
        ),
      );
      const failures: Error[] = [];
      const blockedWorktrees = new Set<string>();
      const placements = await params.placements.getManyAsync(rows.map((row) => row.session_id));
      for (const row of rows) {
        if (
          blockedWorktrees.has(row.worktree_id) ||
          pending.has(row.session_id) ||
          placements.get(row.session_id)?.turnClaim
        ) {
          continue;
        }
        try {
          await processRow(row, () => {
            const placement = params.placements.get(row.session_id);
            return !placement?.turnClaim && !pending.has(row.session_id);
          });
        } catch (error) {
          // Later requests for this checkout must not overtake its unfinished Git transaction.
          blockedWorktrees.add(row.worktree_id);
          failures.push(
            new Error(`Publication ${row.request_id}: ${formatErrorMessage(error)}`, {
              cause: error,
            }),
          );
        }
      }
      // A recoverable index transaction retains its receipt, not the entire queue.
      // Report failures after every independent request has had its turn.
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
      }
    },

    async processClaim(claim: WorkerSessionTurnClaim): Promise<SessionGitHubPublicationResult[]> {
      const rows = await listGitHubPublicationsForClaimAsync(claim);
      await deferGitHubPublicationRequestsAsync(
        { kind: "claimMissingSnapshot", claim },
        params.assertCurrent,
      );
      const results: SessionGitHubPublicationResult[] = [];
      for (const row of rows) {
        if (!row.source_head_commit || !row.source_index_tree || !row.workspace_tree) {
          continue;
        }
        await params.placements.prepareWorkspaceResultClaim(claim);
        results.push(
          await processRow(row, () => params.placements.validateWorkspaceResultClaim(claim)),
        );
      }
      const deferred = await listSharedGitHubPublicationsAsync({
        sessionId: claim.sessionId,
        claimNull: true,
        status: "requested",
      });
      for (const row of deferred) {
        await params.placements.prepareWorkspaceResultClaim(claim);
        results.push(
          await processRow(row, () => params.placements.validateWorkspaceResultClaim(claim)),
        );
      }
      return results;
    },

    /** @deprecated Use deferOrphanedRequestsAsync; removed in the next Plugin SDK major. */
    deferOrphanedRequests(): void {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "deferOrphanedRequests",
        replacement: "deferOrphanedRequestsAsync",
      });
      throw new Error(
        "Await deferOrphanedRequestsAsync; synchronous placement reads are no longer supported.",
      );
    },

    async deferOrphanedRequestsAsync(): Promise<void> {
      await deferGitHubPublicationRequestsAsync({ kind: "orphaned" }, params.assertCurrent);
    },

    /** @deprecated Await listUnreportedResultsAsync; removed in the next Plugin SDK major. */
    listUnreportedResults(): Array<{
      sessionId: string;
      sessionKey: string;
      agentId: string;
      result: SessionGitHubPublicationResult;
    }> {
      const personal = listUnreportedPersonalGitHubPublications();
      if (!schemaExists()) {
        return personal;
      }
      const db = openOpenClawStateDatabase().db;
      return [
        ...personal,
        ...executeSqliteQuerySync(
          db,
          publicationDb(db)
            .selectFrom("github_publication_requests")
            .selectAll()
            .where("status", "in", ["published", "failed"])
            .where("reported_at_ms", "is", null)
            .orderBy("updated_at_ms"),
        ).rows.map((row) => ({
          sessionId: row.session_id,
          sessionKey: row.session_key,
          agentId: row.agent_id,
          result: publicationResult(row),
        })),
      ];
    },

    async listUnreportedResultsAsync() {
      const personal = await listUnreportedPersonalGitHubPublicationsAsync();
      const shared = await listSharedGitHubPublicationsAsync({ pending: false, unreported: true });
      params.assertCurrent();
      return [
        ...personal,
        ...shared.map((row) => ({
          sessionId: row.session_id,
          sessionKey: row.session_key,
          agentId: row.agent_id,
          result: publicationResult(row),
        })),
      ];
    },

    ...createSharedGitHubPublicationReadMethods("worktree"),

    read(requestId: string): SessionGitHubPublicationResult | undefined {
      const row = readById(requestId);
      return row ? publicationResult(row) : undefined;
    },

    /** @deprecated Await markReportedAsync; removed in the next Plugin SDK major. */
    markReported(requestId: string): void {
      markGitHubPublicationReported("personal", requestId);
      ensureSchema();
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const changed = executeSqliteQuerySync(
            db,
            publicationDb(db)
              .updateTable("github_publication_requests")
              .set({ reported_at_ms: Date.now(), updated_at_ms: Date.now() })
              .where("request_id", "=", requestId)
              .where("reported_at_ms", "is", null)
              .returningAll(),
          ).rows;
          for (const row of changed) {
            githubPublicationReceipts.stageRow(db, "shared", row);
          }
        },
        undefined,
        { operationLabel: "github-publication.report" },
      );
    },
  };
}
