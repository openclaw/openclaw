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
  writeRepositoryGitHubPublicationInDatabase,
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

export function createGitHubPublicationExecutionStoreFixture(instanceId: string) {
  const write = <T>(
    operation: (store: ReturnType<typeof createGitHubPublicationExecutionStoreInDatabase>) => T,
  ) =>
    runOpenClawStateWriteTransaction((database) =>
      operation(createGitHubPublicationExecutionStoreInDatabase(database, instanceId)),
    );
  return {
    bindWorkspaceSnapshot: (
      ...args: Parameters<
        ReturnType<typeof createGitHubPublicationExecutionStoreInDatabase>["bindWorkspaceSnapshot"]
      >
    ) => write((store) => store.bindWorkspaceSnapshot(...args)),
    updatePublishingFacts: (
      ...args: Parameters<
        ReturnType<typeof createGitHubPublicationExecutionStoreInDatabase>["updatePublishingFacts"]
      >
    ) => write((store) => store.updatePublishingFacts(...args)),
    complete: (
      ...args: Parameters<
        ReturnType<typeof createGitHubPublicationExecutionStoreInDatabase>["complete"]
      >
    ) => write((store) => store.complete(...args)),
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
  return {
    row: claimed,
    ...createGitHubPublicationExecutionEffects({
      write: (values, requireAction) =>
        runOpenClawStateWriteTransaction((database) =>
          writeRepositoryGitHubPublicationInDatabase(
            database,
            row,
            instanceId,
            executionId,
            values,
            requireAction,
            authority,
          ),
        ),
      interruptedStatus: row.owner_profile_id === null ? "requested" : "needs_confirmation",
    }),
  };
}

/** Transaction fixtures use the same effect reducer as the worker owner. */
function createGitHubPublicationExecutionEffects<Row>(params: {
  write: (
    facts: ReturnType<typeof githubPublicationEffectFacts>["values"],
    requireAction: boolean,
  ) => Row;
  interruptedStatus: "requested" | "needs_confirmation";
}) {
  const apply = (transition: GitHubPublicationEffectTransition) => {
    const { values, requireAction } = githubPublicationEffectFacts(
      transition,
      params.interruptedStatus,
    );
    return params.write(values, requireAction);
  };
  return {
    updateHead: (headCommit: string): Row => apply({ operation: "updateHead", headCommit }),
    complete: (result: SessionGitHubPublicationResult): Row =>
      apply({ operation: "complete", result }),
    recordEffect(
      effect: "push" | "pull_request",
      observed?: { headCommit?: string; url?: string },
    ): void {
      apply({ operation: "recordEffect", effect, observed });
    },
    interrupt: (): Row => apply({ operation: "interrupt" }),
  };
}
