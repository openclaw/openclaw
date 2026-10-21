import * as personal from "../gateway/github-personal-publication-store.worker.js";
import { selectGitHubPublicationDeferralsInDatabase } from "../gateway/github-publication-defer.worker.js";
import { captureGitHubPublicationChanges } from "../gateway/github-publication-events.js";
import { githubPublicationEffectFacts } from "../gateway/github-publication-execution-effects.js";
import {
  claimGitHubPublicationExecutionInDatabase,
  bindAcceptedGitHubPublicationClaimSnapshotInDatabase,
  markSharedGitHubPublicationReportedInDatabase,
  createGitHubPublicationExecutionStoreInDatabase,
  deferGitHubPublicationRequestsInDatabase,
} from "../gateway/github-publication-store.worker.js";
import * as repository from "../gateway/github-repository-publication-store.worker.js";
import { sqlPublicationAnchor } from "../infra/sql-connection.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import { captureGitHubPublicationWorkerReceipt } from "./github-publication-receipts.js";
import { publicationRequestOperations } from "./github-publication-request.worker.js";
import { readGitHubPublicationSessionLifecycle } from "./github-publication-session-lifecycles.worker.js";
import type { GitHubPublicationSourcePredicate } from "./github-publication-source-contract.js";
import {
  assertGitHubPublicationConnectionSource,
  assertGitHubPublicationWorktreeSource,
} from "./github-publication-source.kernel.js";
import {
  assertGitHubPublicationWorkerSourceCurrent,
  withGitHubPublicationSourceTransaction,
} from "./github-publication-source.worker.js";
import type {
  PersonalPublicationMutation,
  SharedPublicationMutation,
  RepositoryPublicationMutation,
  PublicationMutationResult,
} from "./github-publication-worker.types.js";
import type { PublicationWorkerOperations } from "./github-publication.worker-contract.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

function assertCustody(database: OpenClawStateDatabase) {
  if (!database.db.isOpen || !database.db.isTransaction) {
    throw new Error("GitHub publication lost its destination transaction.");
  }
}

function mutate(
  database: OpenClawStateDatabase,
  input: { operation: string; source?: GitHubPublicationSourcePredicate },
  kind: PublicationMutationResult["kind"],
  write: () => PublicationMutationResult,
) {
  const requiresSource =
    (input.operation === "claim" && kind === "personal") ||
    input.operation === "bindWorkspaceSnapshot" ||
    input.operation === "checkpoint";
  if (requiresSource && !input.source) {
    throw new Error("GitHub publication action requires a typed source.");
  }
  const source = input.source;
  const capture = () =>
    captureGitHubPublicationWorkerReceipt(sqlPublicationAnchor(database.db), () => {
      const { value, changes } = captureGitHubPublicationChanges(write);
      return { ...value, changes };
    });
  if (source) {
    return withGitHubPublicationSourceTransaction(database, source, () => {
      assertGitHubPublicationWorkerSourceCurrent(database.db);
      const receipt = capture();
      assertMutationSource(database, receipt, source);
      assertGitHubPublicationWorkerSourceCurrent(database.db);
      deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(database.db), receipt);
      return receipt;
    });
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Accepted bookkeeping can settle after caller revocation; it grants no GitHub action.
      const receipt = capture();
      deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(db), receipt);
      return receipt;
    },
    { database },
    { operationLabel: `github-publication.${input.operation}` },
  );
}

function assertMutationSource(
  database: OpenClawStateDatabase,
  result: PublicationMutationResult,
  source: GitHubPublicationSourcePredicate,
): void {
  if (result.kind === "maintenance") {
    return;
  }
  const { selector } = source;
  // Validate authoritative postimages before COMMIT, so even a mismatched input
  // receipt cannot use a different session's live source capability.
  for (const row of result.rows) {
    if (
      row.session_id !== selector.sessionId ||
      row.session_key !== selector.sessionKey ||
      row.agent_id !== selector.agentId
    ) {
      throw new Error("GitHub publication transition source session changed.");
    }
  }
  if (result.kind === "repository") {
    for (const row of result.rows) {
      if (
        row.workspace_id !== selector.repositoryWorkspaceId ||
        row.session_lifecycle_revision !== selector.lifecycleRevision ||
        (selector.repositoryBranch !== undefined && row.branch !== selector.repositoryBranch)
      ) {
        throw new Error("GitHub publication transition source repository changed.");
      }
      const workspace = source.expected.repositoryWorkspace;
      if (
        workspace?.workspaceId !== row.workspace_id ||
        workspace.agentId !== row.agent_id ||
        workspace.sessionKey !== row.session_key ||
        workspace.branch !== row.branch
      ) {
        throw new Error("GitHub publication transition source repository changed.");
      }
      if (row.owner_profile_id !== null) {
        if (row.connection_generation === null || row.identity_profile_id === null) {
          throw new Error("GitHub publication transition connection is unavailable.");
        }
        assertGitHubPublicationConnectionSource(source, {
          ...row,
          owner_profile_id: row.owner_profile_id,
          connection_generation: row.connection_generation,
          identity_profile_id: row.identity_profile_id,
        });
      }
    }
    return;
  }
  for (const row of result.rows) {
    const lifecycle = readGitHubPublicationSessionLifecycle(
      { publicationKind: result.kind, requestId: row.request_id },
      database.db,
    );
    if (!lifecycle || lifecycle.lifecycle_revision !== selector.lifecycleRevision) {
      throw new Error("GitHub publication transition source lifecycle changed.");
    }
    assertGitHubPublicationWorktreeSource(source, {
      id: row.worktree_id,
      repoFingerprint: row.repository_fingerprint,
      branch: row.branch,
    });
  }
  if (result.kind === "personal") {
    for (const row of result.rows) {
      assertGitHubPublicationConnectionSource(source, row);
    }
  }
}

function personalMutation(database: OpenClawStateDatabase, input: PersonalPublicationMutation) {
  const admitted = () => assertGitHubPublicationWorkerSourceCurrent(database.db);
  switch (input.operation) {
    case "claim":
      return [
        personal.claimPersonalGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          admitted,
        ),
      ];
    case "updateHead":
    case "complete":
    case "recordEffect":
    case "interrupt": {
      const values = githubPublicationEffectFacts(input, "needs_confirmation");
      return [
        personal.writePersonalGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          values,
        ),
      ];
    }
    case "restart":
      return personal.requirePersonalGitHubPublicationConfirmationInDatabase(
        database,
        input.instanceId,
      );
    case "report": {
      const row = personal.markPersonalGitHubPublicationReportedInDatabase(
        database,
        input.requestId,
      );
      return row ? [row] : [];
    }
  }
  throw new Error("Unknown personal GitHub publication mutation.");
}

function repositoryMutation(database: OpenClawStateDatabase, input: RepositoryPublicationMutation) {
  const admitted = () => assertGitHubPublicationWorkerSourceCurrent(database.db);
  const authority = { assertCurrent: admitted, assertCustody: () => assertCustody(database) };
  switch (input.operation) {
    case "claim":
      return [
        repository.claimRepositoryGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          authority,
        ),
      ];
    case "updateHead":
    case "complete":
    case "recordEffect":
    case "interrupt": {
      const values = githubPublicationEffectFacts(
        input,
        input.row.owner_profile_id === null ? "requested" : "needs_confirmation",
      );
      return [
        repository.writeRepositoryGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          values,
        ),
      ];
    }
    case "checkpoint":
      return [
        repository.bindRepositoryGitHubPublicationCheckpointInDatabase(
          database,
          input.row,
          input.checkpoint,
          admitted,
        ),
      ];
    case "failPreparation":
      return [
        repository.failRepositoryGitHubPublicationPreparationInDatabase(
          database,
          input.row,
          input.nextAction,
          authority.assertCustody,
        ),
      ];
    case "defer":
      return repository.deferRepositoryGitHubPublicationClaimsInDatabase(
        database,
        selectGitHubPublicationDeferralsInDatabase(database.db, "repository", input.selection),
      );
    case "retire": {
      // Recovery observed the stale source while holding the workspace reservation.
      const row = repository.failStaleRepositoryGitHubPublicationInDatabase(
        database,
        input.row,
        () => false,
      );
      return row ? [row] : [];
    }
    case "report": {
      const row = repository.markRepositoryGitHubPublicationReportedInDatabase(
        database,
        input.requestId,
      );
      return row ? [row] : [];
    }
  }
  throw new Error("Unknown repository GitHub publication mutation.");
}

function sharedMutation(database: OpenClawStateDatabase, input: SharedPublicationMutation) {
  switch (input.operation) {
    case "bindAcceptedSnapshot":
      return [bindAcceptedGitHubPublicationClaimSnapshotInDatabase(database, input.input)];

    case "report": {
      const row = markSharedGitHubPublicationReportedInDatabase(database, input.requestId);
      return row ? [row] : [];
    }
    case "claim":
      return [
        claimGitHubPublicationExecutionInDatabase(database, input.requestId, input.instanceId),
      ];
    case "defer":
      deferGitHubPublicationRequestsInDatabase(
        database,
        selectGitHubPublicationDeferralsInDatabase(database.db, "shared", input.selection),
      );
      return [];
    case "bindWorkspaceSnapshot":
      return [
        createGitHubPublicationExecutionStoreInDatabase(
          database,
          input.instanceId,
        ).bindWorkspaceSnapshot(input.input),
      ];
    case "updatePublishingFacts":
      return [
        createGitHubPublicationExecutionStoreInDatabase(
          database,
          input.instanceId,
        ).updatePublishingFacts(input.input),
      ];
    case "complete":
      return [
        createGitHubPublicationExecutionStoreInDatabase(database, input.instanceId).complete(
          input.row,
          input.result,
        ),
      ];
  }
  throw new Error("Unknown shared GitHub publication mutation.");
}

export const publicationOperations = {
  ...publicationRequestOperations,
  "githubPublications.maintenance": (
    input: PublicationWorkerOperations["githubPublications.maintenance"]["input"],
    { open },
  ) => {
    const database = open();
    return mutate(database, input, "maintenance", () => {
      if (input.operation === "report") {
        personalMutation(database, input);
        sharedMutation(database, input);
        repositoryMutation(database, input);
      } else {
        const deferred = {
          operation: "defer",
          selection: { kind: "claim", claim: input.claim },
        } as const;
        sharedMutation(database, deferred);
        repositoryMutation(database, deferred);
      }
      return {
        operationId: input.operationId,
        operation: input.operation,
        kind: "maintenance",
        rows: [],
      };
    });
  },
  "githubPublications.shared": (
    input: PublicationWorkerOperations["githubPublications.shared"]["input"],
    { open },
  ) => {
    const database = open();
    return mutate(database, input, "shared", () => ({
      operationId: input.operationId,
      operation: input.operation,
      kind: "shared",
      rows: sharedMutation(database, input),
    }));
  },
  "githubPublications.personal": (
    input: PublicationWorkerOperations["githubPublications.personal"]["input"],
    { open },
  ) => {
    const database = open();
    return mutate(database, input, "personal", () => ({
      operationId: input.operationId,
      operation: input.operation,
      kind: "personal",
      rows: personalMutation(database, input),
    }));
  },
  "githubPublications.repository": (
    input: PublicationWorkerOperations["githubPublications.repository"]["input"],
    { open },
  ) => {
    const database = open();
    return mutate(database, input, "repository", () => ({
      operationId: input.operationId,
      operation: input.operation,
      kind: "repository",
      rows: repositoryMutation(database, input),
    }));
  },
} satisfies WorkerOperationHandlers;
