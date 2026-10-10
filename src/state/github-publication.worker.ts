import * as personal from "../gateway/github-personal-publication-store.js";
import { selectGitHubPublicationDeferralsInDatabase } from "../gateway/github-publication-defer.kernel.js";
import { captureGitHubPublicationChanges } from "../gateway/github-publication-events.js";
import { githubPublicationEffectFacts } from "../gateway/github-publication-execution-effects.js";
import {
  claimGitHubPublicationExecutionInDatabase,
  bindAcceptedGitHubPublicationClaimSnapshotInDatabase,
  markSharedGitHubPublicationReportedInDatabase,
  createGitHubPublicationExecutionStoreInDatabase,
  deferGitHubPublicationRequestsInDatabase,
} from "../gateway/github-publication-store.js";
import * as repository from "../gateway/github-repository-publication-store.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import { captureGitHubPublicationWorkerReceipt } from "./github-publication-receipts.js";
import { publicationRequestOperations } from "./github-publication-request.worker.js";
import { readGitHubPublicationSessionLifecycle } from "./github-publication-session-lifecycles.js";
import type { GitHubPublicationSourcePredicate } from "./github-publication-source-contract.js";
import {
  assertGitHubPublicationConnectionSource,
  assertGitHubPublicationWorktreeSource,
} from "./github-publication-source.kernel.js";
import { assertGitHubPublicationWorkerSourceCurrent } from "./github-publication-source.worker.js";
import type {
  PersonalPublicationMutation,
  SharedPublicationMutation,
  RepositoryPublicationMutation,
  PublicationMutationReceipt,
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

function requiresSource(
  kind: PublicationMutationReceipt["kind"],
  input: PersonalPublicationMutation | RepositoryPublicationMutation | SharedPublicationMutation,
): boolean {
  if (input.operation === "claim") {
    return kind === "personal";
  }
  if (
    input.operation === "bindWorkspaceSnapshot" ||
    input.operation === "updatePublishingFacts" ||
    input.operation === "checkpoint" ||
    input.operation === "failPreparation" ||
    input.operation === "retire"
  ) {
    return true;
  }
  if (
    input.operation === "updateHead" ||
    input.operation === "recordEffect" ||
    input.operation === "interrupt" ||
    (input.operation === "complete" && kind !== "shared")
  ) {
    return githubPublicationEffectFacts(
      input,
      kind === "personal" ||
        ("row" in input && "owner_profile_id" in input.row && input.row.owner_profile_id !== null)
        ? "needs_confirmation"
        : "requested",
    ).requireAction;
  }
  return false;
}

function mutate(
  database: OpenClawStateDatabase,
  operation: string,
  write: () => PublicationMutationResult,
  source?: GitHubPublicationSourcePredicate,
) {
  const capture = () =>
    captureGitHubPublicationWorkerReceipt(database.db, () => {
      const { value, changes } = captureGitHubPublicationChanges(write);
      return { ...value, changes };
    });
  if (source) {
    assertGitHubPublicationWorkerSourceCurrent(database.db);
    const receipt = capture();
    assertMutationSource(database, receipt, source);
    assertGitHubPublicationWorkerSourceCurrent(database.db);
    deferSqliteWorkerCommitReceipt(database.db, receipt);
    return receipt;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Accepted bookkeeping can settle after caller revocation; it grants no GitHub action.
      const receipt = capture();
      deferSqliteWorkerCommitReceipt(db, receipt);
      return receipt;
    },
    { database },
    { operationLabel: `github-publication.${operation}` },
  );
}

function assertMutationSource(
  database: OpenClawStateDatabase,
  result: PublicationMutationResult,
  source: GitHubPublicationSourcePredicate,
): void {
  const { selector } = source;
  const retiring = result.operation === "retire";
  if (retiring !== (selector.purpose === "retire")) {
    throw new Error("GitHub publication transition source purpose changed.");
  }
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
      if (retiring) {
        continue;
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
      const { values, requireAction } = githubPublicationEffectFacts(input, "needs_confirmation");
      return [
        personal.writePersonalGitHubPublicationInDatabase(
          database,
          input.row,
          input.instanceId,
          input.executionId,
          values,
          requireAction,
          admitted,
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
      const { values, requireAction } = githubPublicationEffectFacts(
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
          requireAction,
          authority,
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
          admitted,
        ),
      ];
    case "defer":
      return repository.deferRepositoryGitHubPublicationClaimsInDatabase(
        database,
        selectGitHubPublicationDeferralsInDatabase(database.db, "repository", input.selection),
      );
    case "retire": {
      // The host grants this command only while its original session is no longer current.
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
      return deferGitHubPublicationRequestsInDatabase(
        database,
        selectGitHubPublicationDeferralsInDatabase(database.db, "shared", input.selection),
      );
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
  "githubPublications.shared": (
    input: PublicationWorkerOperations["githubPublications.shared"]["input"],
    { open },
  ) => {
    const database = open();
    if (requiresSource("shared", input) && !input.source) {
      throw new Error("GitHub publication action requires a typed source.");
    }
    return mutate(
      database,
      input.operation,
      () => ({
        operationId: input.operationId,
        operation: input.operation,
        kind: "shared",
        rows: sharedMutation(database, input),
      }),
      input.source,
    );
  },
  "githubPublications.personal": (
    input: PublicationWorkerOperations["githubPublications.personal"]["input"],
    { open },
  ) => {
    const database = open();
    if (requiresSource("personal", input) && !input.source) {
      throw new Error("GitHub publication action requires a typed source.");
    }
    return mutate(
      database,
      input.operation,
      () => ({
        operationId: input.operationId,
        operation: input.operation,
        kind: "personal",
        rows: personalMutation(database, input),
      }),
      input.source,
    );
  },
  "githubPublications.repository": (
    input: PublicationWorkerOperations["githubPublications.repository"]["input"],
    { open },
  ) => {
    const database = open();
    if (requiresSource("repository", input) && !input.source) {
      throw new Error("GitHub publication action requires a typed source.");
    }
    return mutate(
      database,
      input.operation,
      () => ({
        operationId: input.operationId,
        operation: input.operation,
        kind: "repository",
        rows: repositoryMutation(database, input),
      }),
      input.source,
    );
  },
} satisfies WorkerOperationHandlers;
