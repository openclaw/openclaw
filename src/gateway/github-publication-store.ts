import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import type {
  GitHubPublicationReceiptTarget,
  GitHubPublicationRow,
  SharedGitHubPublicationFilter,
} from "../state/github-publication-read.types.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import {
  decodeGitHubPublicationRequester,
  matchesGitHubPublicationRequester,
} from "../state/github-publication-requester.js";
import {
  insertGitHubPublicationSessionLifecycle,
  readGitHubPublicationSessionLifecycle,
} from "../state/github-publication-session-lifecycles.js";
import type {
  SharedGitHubPublicationAcceptedSnapshot,
  SharedGitHubPublicationInsert,
  SharedGitHubPublicationPublishingFacts,
  SharedGitHubPublicationWorkspaceSnapshot,
} from "../state/github-publication-worker.types.js";
import { ensureGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { deferSharedGitHubPublicationChanged } from "./github-publication-events.js";
import {
  checkSharedWorktreeReceipt,
  matchesGitHubPublicationIdentityRow,
} from "./github-publication-receipt.js";
import type { WorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

type GitHubPublicationDatabase = Pick<
  StateDatabase,
  | "github_publication_requests"
  | "github_publication_session_lifecycles"
  | "worker_session_placements"
>;
export const githubPublicationDatabase = (db: Parameters<typeof getNodeSqliteKysely>[0]) =>
  getNodeSqliteKysely<GitHubPublicationDatabase>(db);

export function ensureGitHubPublicationStore(): void {
  ensureGitHubPublicationSchema(openOpenClawStateDatabase().db);
}

export function hasGitHubPublicationStore(): boolean {
  return tableExists(openOpenClawStateDatabase().db, "github_publication_requests");
}

export function readGitHubPublicationRequest(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  request: { requestId: string } | { sessionId: string; idempotencyKey: string },
): GitHubPublicationRow | undefined {
  const query = githubPublicationDatabase(db).selectFrom("github_publication_requests").selectAll();
  return executeSqliteQueryTakeFirstSync(
    db,
    "requestId" in request
      ? query.where("request_id", "=", request.requestId)
      : query
          .where("session_id", "=", request.sessionId)
          .where("idempotency_key", "=", request.idempotencyKey),
  );
}

/** Retained publisher/target receipts identify reused PRs whose body keeps an older marker. */
export function readKnownGitHubPublicationPullRequestUrlsInDatabase(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  row: GitHubPublicationReceiptTarget,
): string[] {
  const known = new Set(row.pull_request_url ? [row.pull_request_url] : []);
  for (const receipt of iterateSqliteQuerySync(
    db,
    githubPublicationDatabase(db)
      .selectFrom("github_publication_requests")
      .selectAll()
      .where("worktree_id", "=", row.worktree_id)
      .where("repository_fingerprint", "=", row.repository_fingerprint)
      .where("repository", "=", row.repository)
      .where("branch", "=", row.branch)
      .where("base_branch", "=", row.base_branch)
      .where("identity_account_id", "=", row.identity_account_id)
      .where("status", "=", "published"),
  )) {
    checkSharedWorktreeReceipt(receipt);
    if (receipt.pull_request_url) {
      known.add(receipt.pull_request_url);
    }
  }
  return [...known];
}

export function listGitHubPublicationsForClaim(
  claim: WorkerSessionTurnClaim,
  options: { pendingOnly?: boolean } = {},
): GitHubPublicationRow[] {
  return listGitHubPublicationsForClaimInDatabase(openOpenClawStateDatabase().db, claim, options);
}

export function listGitHubPublicationsForClaimInDatabase(
  db: OpenClawStateDatabase["db"],
  claim: Pick<WorkerSessionTurnClaim, "sessionId" | "claimId" | "runId">,
  options: { pendingOnly?: boolean } = {},
): GitHubPublicationRow[] {
  if (!tableExists(db, "github_publication_requests")) {
    return [];
  }
  let query = githubPublicationDatabase(db)
    .selectFrom("github_publication_requests")
    .selectAll()
    .where("session_id", "=", claim.sessionId)
    .where("claim_id", "=", claim.claimId)
    .where("run_id", "=", claim.runId)
    .orderBy("created_at_ms");
  if (options.pendingOnly) {
    query = query.where("status", "in", ["requested", "publishing"]);
  }
  return executeSqliteQuerySync(db, query).rows;
}

export function listSharedGitHubPublicationsInDatabase(
  db: OpenClawStateDatabase["db"],
  filter: SharedGitHubPublicationFilter,
): GitHubPublicationRow[] {
  if (!tableExists(db, "github_publication_requests")) {
    return [];
  }
  let query = githubPublicationDatabase(db).selectFrom("github_publication_requests").selectAll();
  if (filter.pending !== undefined) {
    query = query.where(
      "status",
      "in",
      filter.pending ? ["requested", "publishing"] : ["published", "failed"],
    );
  }
  if (filter.status !== undefined) {
    query = query.where("status", "=", filter.status);
  }
  if (filter.claimNull !== undefined) {
    query = query.where("claim_id", filter.claimNull ? "is" : "is not", null);
  }
  if (filter.sessionId !== undefined) {
    query = query.where("session_id", "=", filter.sessionId);
  }
  if (filter.unreported) {
    query = query.where("reported_at_ms", "is", null);
  }
  return executeSqliteQuerySync(
    db,
    query.orderBy(filter.unreported ? "updated_at_ms" : "created_at_ms"),
  ).rows;
}

export function markSharedGitHubPublicationReportedInDatabase(
  database: OpenClawStateDatabase,
  requestId: string,
): GitHubPublicationRow | undefined {
  if (!tableExists(database.db, "github_publication_requests")) {
    return undefined;
  }
  const { db } = database;
  const updated = executeSqliteQueryTakeFirstSync(
    db,
    githubPublicationDatabase(db)
      .updateTable("github_publication_requests")
      .set({ reported_at_ms: Date.now(), updated_at_ms: Date.now() })
      .where("request_id", "=", requestId)
      .where("reported_at_ms", "is", null)
      .returningAll(),
  );
  if (updated) {
    githubPublicationReceipts.stageRow(db, "shared", updated);
  }
  return updated;
}

export function assertSharedGitHubPublicationClaimInDatabase(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  request: {
    claim: WorkerSessionTurnClaim;
    sessionKey: string;
    agentId: string;
  },
): void {
  const row = executeSqliteQuerySync(
    db,
    githubPublicationDatabase(db)
      .selectFrom("worker_session_placements")
      .select([
        "agent_id",
        "session_key",
        "state",
        "environment_id",
        "active_owner_epoch",
        "turn_claim_owner",
        "turn_claim_id",
        "turn_claim_run_id",
        "turn_claim_generation",
        "turn_claim_owner_epoch",
      ])
      .where("session_id", "=", request.claim.sessionId),
  ).rows[0];
  const ownerMatches =
    request.claim.owner.kind === "worker"
      ? row?.turn_claim_owner === "worker" &&
        row.environment_id === request.claim.owner.environmentId &&
        row.active_owner_epoch === request.claim.owner.ownerEpoch &&
        row.turn_claim_owner_epoch === request.claim.owner.ownerEpoch
      : row?.turn_claim_owner === "local";
  if (
    !row ||
    (row.state !== "active" && row.state !== "draining" && row.state !== "local") ||
    row.agent_id !== request.agentId ||
    row.session_key !== request.sessionKey ||
    row.turn_claim_id !== request.claim.claimId ||
    row.turn_claim_run_id !== request.claim.runId ||
    row.turn_claim_generation !== request.claim.placementGeneration ||
    !ownerMatches
  ) {
    throw new Error("GitHub publication turn authority changed before recording.");
  }
}

export function claimGitHubPublicationExecution(
  requestId: string,
  gatewayInstanceId: string,
): GitHubPublicationRow {
  return runOpenClawStateWriteTransaction(
    (database) => claimGitHubPublicationExecutionInDatabase(database, requestId, gatewayInstanceId),
    undefined,
    { operationLabel: "github-publication.claim" },
  );
}

export function claimGitHubPublicationExecutionInDatabase(
  database: OpenClawStateDatabase,
  requestId: string,
  gatewayInstanceId: string,
): GitHubPublicationRow {
  const { db } = database;
  const query = githubPublicationDatabase(db);
  const current = readGitHubPublicationRequest(db, { requestId });
  if (!current) {
    throw new Error("GitHub publication request disappeared.");
  }
  if (current.status === "published" || current.status === "failed") {
    return current;
  }
  let update = query
    .updateTable("github_publication_requests")
    .set({
      status: "publishing",
      gateway_instance_id: gatewayInstanceId,
      updated_at_ms: Date.now(),
    })
    .where("request_id", "=", current.request_id)
    .where("status", "=", current.status);
  update = current.gateway_instance_id
    ? update.where("gateway_instance_id", "=", current.gateway_instance_id)
    : update.where("gateway_instance_id", "is", null);
  const claimed = executeSqliteQueryTakeFirstSync(db, update.returningAll());
  if (!claimed) {
    throw new Error("GitHub publication execution ownership changed.");
  }
  githubPublicationReceipts.stageRow(db, "shared", claimed);
  deferSharedGitHubPublicationChanged(db, claimed);
  return claimed;
}

/** Insert/replay shared intent inside the caller's admission transaction. */
export function insertGitHubPublicationRequest(
  db: Parameters<typeof getNodeSqliteKysely>[0],
  input: SharedGitHubPublicationInsert & { assertCurrent: () => void },
): GitHubPublicationRow {
  input.assertCurrent();
  const { request, identity, worktree, claim, snapshot } = input;
  const query = githubPublicationDatabase(db);
  const inserted = executeSqliteQuerySync(
    db,
    query
      .insertInto("github_publication_requests")
      .values({
        request_id: input.requestId,
        idempotency_key: request.idempotencyKey,
        request_digest: input.requestDigest,
        session_id: input.sessionId,
        session_key: request.sessionKey,
        agent_id: request.agentId,
        worktree_id: worktree.id,
        repository_fingerprint: worktree.repoFingerprint,
        claim_id: claim?.claimId ?? null,
        run_id: claim?.runId ?? null,
        environment_id: claim?.owner.environmentId ?? null,
        owner_epoch: claim?.owner.ownerEpoch ?? null,
        placement_generation: claim?.placementGeneration ?? null,
        identity_source: identity.source,
        identity_profile_id: identity.profileId ?? null,
        identity_account_id: identity.account.accountId,
        identity_login: identity.account.login,
        title: request.title ?? null,
        body: request.body ?? null,
        branch: worktree.branch,
        source_head_commit: snapshot?.sourceHeadCommit ?? null,
        source_index_tree: snapshot?.sourceIndexTree ?? null,
        workspace_tree: snapshot?.workspaceTree ?? null,
        created_at_ms: input.now,
        status: "requested",
        updated_at_ms: input.now,
      })
      .onConflict((conflict) => conflict.columns(["session_id", "idempotency_key"]).doNothing()),
  );
  if (inserted.numAffectedRows === 1n) {
    insertGitHubPublicationSessionLifecycle(db, {
      publicationKind: "shared",
      requestId: input.requestId,
      lifecycleRevision: input.lifecycleRevision,
      requester: input.requester,
    });
  }
  const stored = readGitHubPublicationRequest(db, {
    sessionId: input.sessionId,
    idempotencyKey: request.idempotencyKey,
  });
  if (
    !stored ||
    stored.request_digest !== input.requestDigest ||
    !matchesGitHubPublicationIdentityRow(stored, identity) ||
    stored.worktree_id !== worktree.id ||
    stored.repository_fingerprint !== worktree.repoFingerprint ||
    stored.branch !== worktree.branch
  ) {
    throw new Error("GitHub publication idempotency key was reused.");
  }
  if (stored.status !== "published" && stored.status !== "failed") {
    const requester = decodeGitHubPublicationRequester(
      readGitHubPublicationSessionLifecycle(
        { publicationKind: "shared", requestId: stored.request_id },
        db,
      )?.requester_authority_json,
    );
    if (!requester || !matchesGitHubPublicationRequester(requester, input.requester)) {
      throw new Error("GitHub publication requester changed; use a new idempotency key.");
    }
  }
  input.assertCurrent();
  if (inserted.numAffectedRows === 1n) {
    githubPublicationReceipts.stageRow(db, "shared", stored);
    deferSharedGitHubPublicationChanged(db, stored);
  }
  return stored;
}

type SharedPublicationTransition = "bind-workspace" | "begin" | "complete";

function writeGitHubPublicationExecutionInDatabase(
  database: OpenClawStateDatabase,
  instanceId: string,
  row: GitHubPublicationRow,
  values: Partial<GitHubPublicationRow> | undefined,
  transition: SharedPublicationTransition,
): GitHubPublicationRow {
  const errors = {
    "bind-workspace": "GitHub publication workspace snapshot changed before execution.",
    begin: "GitHub publication state changed before execution.",
    complete: "GitHub publication state changed before completion.",
  };
  const { db } = database;
  if (!values) {
    throw new Error("GitHub publication terminal result is invalid.");
  }
  let update = githubPublicationDatabase(db)
    .updateTable("github_publication_requests")
    .set({ ...values, updated_at_ms: Date.now() })
    .where("request_id", "=", row.request_id)
    .where("status", "=", "publishing")
    .where("gateway_instance_id", "=", instanceId);
  if (transition === "bind-workspace") {
    update = update
      .where("source_head_commit", "is", null)
      .where("source_index_tree", "is", null)
      .where("workspace_tree", "is", null);
  }
  const updated = executeSqliteQueryTakeFirstSync(db, update.returningAll());
  if (!updated) {
    throw new Error(errors[transition]);
  }
  githubPublicationReceipts.stageRow(db, "shared", updated);
  deferSharedGitHubPublicationChanged(db, updated);
  return updated;
}

export function createGitHubPublicationExecutionStore(instanceId: string) {
  return createSharedExecutionTransitions((row, values, transition) => {
    return runOpenClawStateWriteTransaction(
      (database) =>
        writeGitHubPublicationExecutionInDatabase(database, instanceId, row, values, transition),
      undefined,
      { operationLabel: `github-publication.${transition}` },
    );
  });
}

export function createGitHubPublicationExecutionStoreInDatabase(
  database: OpenClawStateDatabase,
  instanceId: string,
) {
  return createSharedExecutionTransitions((row, values, transition) =>
    writeGitHubPublicationExecutionInDatabase(database, instanceId, row, values, transition),
  );
}

function createSharedExecutionTransitions(
  write: (
    row: GitHubPublicationRow,
    values: Partial<GitHubPublicationRow> | undefined,
    transition: SharedPublicationTransition,
  ) => GitHubPublicationRow,
) {
  return {
    bindWorkspaceSnapshot: (
      input: SharedGitHubPublicationWorkspaceSnapshot,
    ): GitHubPublicationRow => {
      return write(
        input.row,
        {
          source_head_commit: input.sourceHeadCommit,
          source_index_tree: input.sourceIndexTree,
          workspace_tree: input.workspaceTree,
        },
        "bind-workspace",
      );
    },
    updatePublishingFacts: (
      input: SharedGitHubPublicationPublishingFacts,
    ): GitHubPublicationRow => {
      return write(
        input.row,
        {
          repository: input.repository,
          branch: input.branch,
          base_branch: input.baseBranch,
          source_head_commit: input.sourceHeadCommit,
          workspace_tree: input.workspaceTree,
          head_commit: input.headCommit,
        },
        "begin",
      );
    },
    complete: (
      row: GitHubPublicationRow,
      result: SessionGitHubPublicationResult,
    ): GitHubPublicationRow => {
      const values =
        result.status === "published"
          ? {
              status: "published",
              pull_request_url: result.url,
              repository: result.repository,
              branch: result.branch,
              head_commit: result.headCommit,
              error_code: null,
              next_action: null,
            }
          : result.status === "failed"
            ? {
                status: "failed",
                pull_request_url: null,
                error_code: result.code,
                next_action: result.nextAction,
              }
            : undefined;
      return write(row, values, "complete");
    },
  };
}

export function deferGitHubPublicationRequests(requestIds: string[]): void {
  if (!requestIds.length) {
    return;
  }
  runOpenClawStateWriteTransaction(
    (database) => deferGitHubPublicationRequestsInDatabase(database, requestIds),
    undefined,
    { operationLabel: "github-publication.defer" },
  );
}

const sharedGitHubPublicationAuthorityColumns = [
  "request_id",
  "idempotency_key",
  "request_digest",
  "session_id",
  "session_key",
  "agent_id",
  "worktree_id",
  "repository_fingerprint",
  "claim_id",
  "run_id",
  "environment_id",
  "owner_epoch",
  "placement_generation",
  "identity_source",
  "identity_profile_id",
  "identity_account_id",
  "identity_login",
  "status",
  "gateway_instance_id",
  "repository",
  "branch",
  "base_branch",
  "source_head_commit",
  "source_index_tree",
  "workspace_tree",
  "head_commit",
  "pull_request_url",
  "error_code",
  "created_at_ms",
  "updated_at_ms",
  "reported_at_ms",
] as const satisfies readonly (keyof Omit<
  GitHubPublicationRow,
  "title" | "body" | "next_action"
>)[];

export function deferGitHubPublicationRequestsInDatabase(
  database: OpenClawStateDatabase,
  requestIds: readonly string[],
): void {
  if (requestIds.length === 0) {
    return;
  }
  const { db } = database;
  const query = githubPublicationDatabase(db);
  const updatedAtMs = Date.now();
  for (const requestId of requestIds) {
    const changed = executeSqliteQuerySync(
      db,
      query
        .updateTable("github_publication_requests")
        .set({
          claim_id: null,
          run_id: null,
          environment_id: null,
          owner_epoch: null,
          placement_generation: null,
          status: "requested",
          gateway_instance_id: null,
          updated_at_ms: updatedAtMs,
        })
        .where("request_id", "=", requestId)
        .where("status", "in", ["requested", "publishing"])
        .returning(sharedGitHubPublicationAuthorityColumns),
    ).rows;
    for (const row of changed) {
      githubPublicationReceipts.stageRow(db, "shared", row);
      deferSharedGitHubPublicationChanged(db, row);
    }
  }
}

export function isGitHubPublicationExecutionOwner(
  requestId: string,
  gatewayInstanceId: string,
): boolean {
  ensureGitHubPublicationStore();
  const db = openOpenClawStateDatabase().db;
  const row = executeSqliteQuerySync(
    db,
    githubPublicationDatabase(db)
      .selectFrom("github_publication_requests")
      .select(["status", "gateway_instance_id"])
      .where("request_id", "=", requestId),
  ).rows[0];
  return row?.status === "publishing" && row.gateway_instance_id === gatewayInstanceId;
}

export function markGitHubPublicationReported(
  kind: "personal" | "repository",
  requestId: string,
): void {
  const table =
    kind === "personal"
      ? "github_personal_publication_requests"
      : "github_repository_publication_requests";
  if (!tableExists(openOpenClawStateDatabase().db, table)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const changed = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<StateDatabase, typeof table>>(db)
          .updateTable(table)
          .set({ reported_at_ms: Date.now() })
          .where("request_id", "=", requestId)
          .where("status", "in", ["published", "failed"])
          .returningAll(),
      ).rows;
      for (const row of changed) {
        githubPublicationReceipts.stageRow(db, kind, row);
      }
    },
    undefined,
    { operationLabel: `github-${kind}-publication.report` },
  );
}

export function bindAcceptedGitHubPublicationClaimSnapshotInDatabase(
  database: OpenClawStateDatabase,
  input: SharedGitHubPublicationAcceptedSnapshot,
): GitHubPublicationRow {
  const { db } = database;

  assertSharedGitHubPublicationClaimInDatabase(db, {
    claim: input.claim,
    sessionKey: input.row.session_key,
    agentId: input.row.agent_id,
  });
  const query = githubPublicationDatabase(db);
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
  githubPublicationReceipts.stageRow(db, "shared", updated);
  deferSharedGitHubPublicationChanged(db, updated);
  return updated;
}
