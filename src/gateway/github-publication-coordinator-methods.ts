import { randomUUID } from "node:crypto";
import type {
  GitHubPublicationPublisher,
  SessionGitHubPublicationResult,
  SessionGitHubPublishParams,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { GitHubPublicationRow as PublicationRow } from "../state/github-publication-read.types.js";
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
} from "./github-publication-availability.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import type { GitHubPublicationRequester } from "./github-publication-requester.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import {
  deferGitHubPublicationRequests as deferRequests,
  digestGitHubPublicationRequest as digestRequest,
  insertGitHubPublicationRequest,
  ensureGitHubPublicationStore as ensureSchema,
  githubPublicationDatabase as publicationDb,
  hasGitHubPublicationStore as schemaExists,
  listGitHubPublicationsForClaim,
  markGitHubPublicationReported,
  projectGitHubPublicationResult as publicationResult,
  readGitHubPublicationRequest,
} from "./github-publication-store.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { projectWorkerSessionTurnClaim } from "./worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";
import type { WorkerWorkspacePendingResult } from "./worker-environments/placement-workspace-result.types.js";

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

export type GitHubPublicationSessionRequest = SessionGitHubPublishParams & {
  agentId: string;
  expectedRunId?: string;
  requester: GitHubPublicationRequester;
};

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
  readById: (requestId: string) => PublicationRow | undefined;
  requestForClaim: (
    request: GitHubPublicationClaimRequest,
  ) => Promise<SessionGitHubPublicationResult>;
  sameWorktree: (
    row: PublicationRow,
    worktree: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>["worktree"],
  ) => boolean;
  processRow: (
    initial: PublicationRow,
    validateExecution: () => boolean,
    assertInvocationCurrent?: () => void,
  ) => Promise<SessionGitHubPublicationResult>;
}) {
  const { readById, requestForClaim, sameWorktree, processRow } = params;
  const deferOrphanedRequestsWithPendingResults = (
    results: readonly WorkerWorkspacePendingResult[],
  ): void => {
    const pending = new Set(results.map((row) => `${row.sessionId}\0${row.claimId}\0${row.runId}`));
    const db = openOpenClawStateDatabase().db;
    const rows = executeSqliteQuerySync(
      db,
      publicationDb(db)
        .selectFrom("github_publication_requests")
        .selectAll()
        .where("status", "in", ["requested", "publishing"])
        .orderBy("created_at_ms"),
    ).rows;
    const orphaned = rows.filter((row) => {
      if (row.claim_id === null) {
        return false;
      }
      const ownerKey = `${row.session_id}\0${row.claim_id}\0${row.run_id}`;
      const placement = params.placements.get(row.session_id);
      const liveClaim = placement?.turnClaim;
      const stillLive =
        liveClaim?.claimId === row.claim_id &&
        liveClaim.runId === row.run_id &&
        liveClaim.generation === row.placement_generation;
      return !pending.has(ownerKey) && !stillLive;
    });
    deferRequests(orphaned.map((row) => row.request_id));
  };

  return {
    async requestForSession(
      input: GitHubPublicationSessionRequest,
    ): Promise<SessionGitHubPublicationResult> {
      if (input.selection?.source === "personal") {
        throw new Error("My GitHub publication requires direct personal authorization.");
      }
      const expected = input.selection?.expected;
      const assertRequester = input.requester.assertCurrent;
      ensureSchema();
      if (!input.sessionKey) {
        throw new Error("GitHub publication requires an authoritative session.");
      }
      assertRequester();
      const initialLoaded = loadGatewaySessionEntryReadOnly(input.sessionKey, {
        agentId: input.agentId,
      });
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
        const accepted = await requestForClaim({
          expectedPublisher: expected,
          claim,
          sessionKey: loaded.canonicalKey,
          agentId: input.agentId,
          idempotencyKey: input.idempotencyKey,
          requester: input.requester,
          ...(input.title ? { title: input.title } : {}),
          ...(input.body ? { body: input.body } : {}),
        });
        assertRequester();
        if (placement?.state !== "local") {
          return accepted;
        }
        const row = readById(accepted.requestId);
        if (!row) {
          throw new Error("GitHub publication request disappeared.");
        }
        return await processRow(
          row,
          () => params.placements.validateTurnClaim(claim),
          input.requester.assertInvocationCurrent,
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
      const database = openOpenClawStateDatabase().db;
      const readRequest = () =>
        readGitHubPublicationRequest(database, {
          sessionId,
          idempotencyKey: input.idempotencyKey,
        });
      const existing = readRequest();
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
              hasRequest: () => Boolean(readRequest()),
            },
      );
      const insertSessionRequest = (snapshot?: {
        sourceHeadCommit: string;
        sourceIndexTree: string;
        workspaceTree: string;
      }): PublicationRow => {
        const now = Date.now();
        const requestId = randomUUID();
        assertRequester();
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
        return publicationResult(insertSessionRequest());
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
      const row = insertSessionRequest(snapshot);
      return await processRow(row, validateLocalExecution, input.requester.assertInvocationCurrent);
    },

    async resumeSessionRequests(): Promise<void> {
      if (!schemaExists()) {
        return;
      }
      const db = openOpenClawStateDatabase().db;
      const rows = executeSqliteQuerySync(
        db,
        publicationDb(db)
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("claim_id", "is", null)
          .where("status", "in", ["requested", "publishing"])
          .orderBy("created_at_ms"),
      ).rows;
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
      ensureSchema();
      const db = openOpenClawStateDatabase().db;
      const rows = listGitHubPublicationsForClaim(claim);
      const missingSnapshots = rows.filter(
        (row) => !row.source_head_commit || !row.source_index_tree || !row.workspace_tree,
      );
      deferRequests(missingSnapshots.map((row) => row.request_id));
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
      const deferred = executeSqliteQuerySync(
        db,
        publicationDb(db)
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("session_id", "=", claim.sessionId)
          .where("claim_id", "is", null)
          .where("status", "=", "requested")
          .orderBy("created_at_ms"),
      ).rows;
      for (const row of deferred) {
        await params.placements.prepareWorkspaceResultClaim(claim);
        results.push(
          await processRow(row, () => params.placements.validateWorkspaceResultClaim(claim)),
        );
      }
      return results;
    },

    /** @deprecated Await deferOrphanedRequestsAsync; retained for released plugin contexts. */
    deferOrphanedRequests(): void {
      if (!schemaExists()) {
        return;
      }
      deferOrphanedRequestsWithPendingResults(params.placements.listPendingWorkspaceResults());
    },

    async deferOrphanedRequestsAsync(): Promise<void> {
      if (!schemaExists()) {
        return;
      }
      deferOrphanedRequestsWithPendingResults(
        await params.placements.listPendingWorkspaceResultsAsync(),
      );
    },

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

    ...createSharedGitHubPublicationReadMethods("worktree"),

    read(requestId: string): SessionGitHubPublicationResult | undefined {
      const row = readById(requestId);
      return row ? publicationResult(row) : undefined;
    },

    markReported(requestId: string): void {
      markGitHubPublicationReported("personal", requestId);
      ensureSchema();
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            publicationDb(db)
              .updateTable("github_publication_requests")
              .set({ reported_at_ms: Date.now(), updated_at_ms: Date.now() })
              .where("request_id", "=", requestId)
              .where("reported_at_ms", "is", null),
          );
        },
        undefined,
        { operationLabel: "github-publication.report" },
      );
    },
  };
}
