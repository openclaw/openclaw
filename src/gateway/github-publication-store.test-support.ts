import { randomUUID } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { ensureGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  githubPublicationEffectFacts,
  type GitHubPublicationEffectTransition,
} from "./github-publication-execution-effects.js";
import {
  claimGitHubPublicationExecutionInDatabase,
  createGitHubPublicationExecutionStoreInDatabase,
  deferGitHubPublicationRequestsInDatabase,
} from "./github-publication-store.worker.js";
import {
  bindRepositoryGitHubPublicationCheckpointInDatabase,
  claimRepositoryGitHubPublicationInDatabase,
  deferRepositoryGitHubPublicationClaimsInDatabase,
  failRepositoryGitHubPublicationPreparationInDatabase,
  insertRepositoryGitHubPublicationInDatabase,
  readRepositoryGitHubPublicationInDatabase,
  writeRepositoryGitHubPublicationInDatabase as writeRepository,
} from "./github-repository-publication-store.worker.js";

// These fixtures exercise transaction publication directly; runtime callers use worker commands.
function transaction<Args extends unknown[], Result>(
  operation: (database: OpenClawStateDatabase, ...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => runOpenClawStateWriteTransaction((database) => operation(database, ...args));
}

export function ensureGitHubPublicationStoreFixture() {
  ensureGitHubPublicationSchema(openOpenClawStateDatabase().db);
}

export const claimGitHubPublicationExecutionFixture = transaction(
  claimGitHubPublicationExecutionInDatabase,
);
export const deferGitHubPublicationRequestsFixture = transaction(
  deferGitHubPublicationRequestsInDatabase,
);
export const insertRepositoryGitHubPublicationFixture = transaction(
  insertRepositoryGitHubPublicationInDatabase,
);
export const bindRepositoryGitHubPublicationCheckpointFixture = transaction(
  bindRepositoryGitHubPublicationCheckpointInDatabase,
);
export const failRepositoryGitHubPublicationPreparationFixture = transaction(
  failRepositoryGitHubPublicationPreparationInDatabase,
);
export const deferRepositoryGitHubPublicationClaimsFixture = transaction(
  deferRepositoryGitHubPublicationClaimsInDatabase,
);

export function readRepositoryGitHubPublicationFixture(requestId: string) {
  return readRepositoryGitHubPublicationInDatabase(openOpenClawStateDatabase().db, requestId);
}

type ExecutionStore = ReturnType<typeof createGitHubPublicationExecutionStoreInDatabase>;

export function createGitHubPublicationExecutionStoreFixture(instanceId: string) {
  const write = <T>(operation: (store: ExecutionStore) => T) =>
    runOpenClawStateWriteTransaction((database) =>
      operation(createGitHubPublicationExecutionStoreInDatabase(database, instanceId)),
    );
  return {
    bindWorkspaceSnapshot: (...args: Parameters<ExecutionStore["bindWorkspaceSnapshot"]>) =>
      write((store) => store.bindWorkspaceSnapshot(...args)),
    updatePublishingFacts: (...args: Parameters<ExecutionStore["updatePublishingFacts"]>) =>
      write((store) => store.updatePublishingFacts(...args)),
    complete: (...args: Parameters<ExecutionStore["complete"]>) =>
      write((store) => store.complete(...args)),
  };
}

export function claimRepositoryGitHubPublicationFixture(
  row: Parameters<typeof claimRepositoryGitHubPublicationInDatabase>[1],
  instanceId: string,
  authority: Parameters<typeof claimRepositoryGitHubPublicationInDatabase>[4],
) {
  const executionId = randomUUID();
  const claimed = runOpenClawStateWriteTransaction((database) =>
    claimRepositoryGitHubPublicationInDatabase(database, row, instanceId, executionId, authority),
  );
  const interruptedStatus = row.owner_profile_id === null ? "requested" : "needs_confirmation";
  const apply = (transition: GitHubPublicationEffectTransition) => {
    const values = githubPublicationEffectFacts(transition, interruptedStatus);
    return runOpenClawStateWriteTransaction((database) =>
      writeRepository(database, row, instanceId, executionId, values),
    );
  };
  return {
    row: claimed,
    updateHead: (headCommit: string) => apply({ operation: "updateHead", headCommit }),
    complete: (result: SessionGitHubPublicationResult) => apply({ operation: "complete", result }),
    recordEffect(
      effect: "push" | "pull_request",
      observed?: { headCommit?: string; url?: string },
    ): void {
      apply({ operation: "recordEffect", effect, observed });
    },
    interrupt: () => apply({ operation: "interrupt" }),
  };
}
