import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { assertSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "./openclaw-state-worker-store.js";
import {
  prepareRepositoryWorkspaceRead,
  stageRepositoryWorkspacePublication,
} from "./session-repository-workspaces.publication.js";
import {
  isRepositoryWorkspace,
  repositoryWorkspacePublication,
} from "./session-repository-workspaces.receipts.js";
import type {
  RepositoryWorkspaceBase,
  RepositoryWorkspaceCheckpoint,
  RepositoryWorkspaceCreate,
  RepositoryWorkspaceMutationResult,
  RepositoryWorkspaceOwner,
  SessionRepositoryWorkspaceRecord,
} from "./session-repository-workspaces.types.js";
import type { RepositoryWorkspaceWorkerOperations } from "./session-repository-workspaces.worker-contract.js";

export type { PreparedRepositoryWorkspace } from "./session-repository-workspaces.publication.js";

type Guarded<T> = T & { assertCurrent: () => void };
type Mutation = Exclude<
  SqliteWorkerCommand<RepositoryWorkspaceWorkerOperations>,
  { type: "repositoryWorkspaces.get" | "repositoryWorkspaces.find" }
>;

function committedResult(facts: unknown): unknown {
  return isRecord(facts) ? facts.result : undefined;
}

function isMutationResult(value: unknown): value is RepositoryWorkspaceMutationResult {
  return (
    isRecord(value) &&
    typeof value.workspaceId === "string" &&
    typeof value.changed === "boolean" &&
    (value.workspace === undefined || isRepositoryWorkspace(value.workspace)) &&
    (value.owner === undefined ||
      (isRecord(value.owner) &&
        typeof value.owner.agentId === "string" &&
        typeof value.owner.sessionKey === "string"))
  );
}

/** Deletion preparation must not reopen the shared database on the caller thread. */
export async function findSessionRepositoryWorkspaces(
  owners: readonly RepositoryWorkspaceOwner[],
  options: { path: string; env?: NodeJS.ProcessEnv },
): Promise<SessionRepositoryWorkspaceRecord[]> {
  const reply = await executeExistingOpenClawStateRead(options, {
    type: "sessionRepositoryWorkspaces.find",
    owners: owners.map(({ agentId, sessionKey }) => ({ agentId, sessionKey })),
  });
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "sessionRepositoryWorkspaces.find") {
    throw new Error("Unexpected session repository workspace lookup result");
  }
  return reply.workspaces;
}

export function createSessionRepositoryWorkspaceStore(
  options: {
    path?: string;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const env = options.env && cloneEnvWithPlatformSemantics(options.env);
  const databasePath = resolveDatabasePath({ path: options.path, env });
  const now = options.now;
  const context = () => captureOpenClawStateWorkerContext({ path: databasePath, env });
  async function mutate(
    command: Mutation,
    assertCurrent: () => void,
    control: {
      afterCommit?: () => Promise<void>;
      sessionEntryCurrent?: SessionEntryCurrentCheck;
    } = {},
  ) {
    const { afterCommit, sessionEntryCurrent } = control;
    const captured = context();
    let admission: SqliteWorkerOperationAdmission | undefined;
    let prepared: RepositoryWorkspaceMutationResult | undefined;
    let publication: ReturnType<typeof stageRepositoryWorkspacePublication> | undefined;
    let publicationSettled: Promise<void> | undefined;
    let granted = false;
    let cleanupSourceIdentity: string | undefined;
    let finalized = afterCommit === undefined;
    const check = () => {
      captured.admission.assertCurrent();
      assertCurrent();
    };
    try {
      return await runOpenClawStateWorkerOperation(
        captured,
        async (scope) => {
          let result: RepositoryWorkspaceMutationResult;
          try {
            result = await scope.execute(command);
          } catch (error) {
            await publicationSettled;
            if (
              !prepared ||
              !admission?.committed ||
              !isDeepStrictEqual(committedResult(admission.committed.facts), prepared)
            ) {
              throw error;
            }
            result = prepared;
          }
          await publicationSettled;
          if (afterCommit) {
            if (
              !granted ||
              !cleanupSourceIdentity ||
              !prepared ||
              !admission?.committed ||
              !isDeepStrictEqual(committedResult(admission.committed.facts), prepared)
            ) {
              throw new Error("Repository workspace cleanup has no committed source");
            }
            // The committed delete owns this retained tail; closing fresh reads must join it.
            assertExistingDatabaseIdentity(databasePath, cleanupSourceIdentity);
            await afterCommit();
            finalized = true;
          }
          return result;
        },
        {
          assertCurrent: check,
          createAdmission: (operation) => {
            const domainPublication = repositoryWorkspacePublication.begin({
              get identity() {
                return captured.admission.identity.key;
              },
              assertCurrent: captured.assertPublicationCurrent ?? captured.admission.assertCurrent,
            });
            admission = createSqliteWorkerOperationAdmission((request, grant) => {
              check();
              const admitted = assertSessionEntryCurrentAdmission(request, sessionEntryCurrent);
              if (admitted.stage === "transaction") {
                grant();
                return;
              }
              if (admitted.stage !== "commit" || !isMutationResult(admitted.facts)) {
                throw new Error("Repository workspace mutation has no admitted commit result");
              }
              prepared = admitted.facts;
              if (afterCommit) {
                const identity = captured.admission.identity;
                assertExistingDatabaseIdentity(databasePath, identity.key);
                cleanupSourceIdentity = identity.key;
              }
              publication = stageRepositoryWorkspacePublication(captured.admission, prepared);
              granted = grant();
            });
            observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
              if (!isRecord(facts)) {
                throw new Error("Repository workspace has no committed receipt");
              }
              domainPublication.committed(facts.receipt);
            });
            const acceptedAdmission = admission;
            publicationSettled = operation.settled.then((settlement) => {
              let committed = false;
              let known = false;
              try {
                const receipt = acceptedAdmission.committed;
                if (receipt) {
                  if (!prepared || !isDeepStrictEqual(committedResult(receipt.facts), prepared)) {
                    throw new Error("Repository workspace commit result changed during settlement");
                  }
                  committed = true;
                }
                known = !granted || committed || settlement.kind === "completed";
              } finally {
                publication?.settle(committed, known);
                domainPublication.finish(
                  settlement.kind === "completed",
                  settlement.kind === "completed" && !granted && !acceptedAdmission.committed,
                );
              }
              if (committed && prepared?.changed && prepared.owner) {
                try {
                  captured.admission.assertCurrent();
                } catch {
                  // A retired source cannot publish into its replacement, or erase a committed result.
                  return;
                }
                sessionChanges.emit(prepared.owner);
              }
            });
            void publicationSettled.catch(() => undefined);
            return { admission, nativeLocations: [databasePath] };
          },
        },
      );
    } catch (error) {
      // A settled native commit owns its result even if the ordinary reply was lost.
      if (
        finalized &&
        prepared &&
        admission?.committed &&
        isDeepStrictEqual(committedResult(admission.committed.facts), prepared)
      ) {
        return prepared;
      }
      throw error;
    } finally {
      await publicationSettled;
    }
  }
  const requireWorkspace = (result: RepositoryWorkspaceMutationResult) => {
    if (!result.workspace) {
      throw new Error("Repository workspace mutation returned no workspace");
    }
    return result.workspace;
  };
  const artifactPath = (workspaceId: string): string => {
    if (!/^[a-f0-9-]{36}$/u.test(workspaceId)) {
      throw new Error("Repository workspace id is invalid");
    }
    return path.join(path.dirname(databasePath), "repository-workspaces", `${workspaceId}.git`);
  };
  return {
    path: databasePath,
    artifactPath,
    get(workspaceId: string) {
      return executeOpenClawStateWorker(context(), {
        type: "repositoryWorkspaces.get",
        input: { workspaceId },
      });
    },
    find(owner: RepositoryWorkspaceOwner) {
      return executeOpenClawStateWorker(context(), {
        type: "repositoryWorkspaces.find",
        input: { agentId: owner.agentId, sessionKey: owner.sessionKey },
      });
    },
    prepare(workspaceId: string) {
      const captured = context();
      return prepareRepositoryWorkspaceRead(captured.admission, workspaceId, () =>
        executeOpenClawStateWorker(captured, {
          type: "repositoryWorkspaces.get",
          input: { workspaceId },
        }),
      );
    },
    async create(input: Guarded<RepositoryWorkspaceCreate>) {
      return requireWorkspace(
        await mutate(
          {
            type: "repositoryWorkspaces.create",
            input: {
              agentId: input.agentId,
              sessionKey: input.sessionKey,
              url: input.url,
              requestedRef: input.requestedRef,
              runSetupScript: input.runSetupScript,
              branch: input.branch,
              nowMs: now?.(),
            },
          },
          input.assertCurrent,
        ),
      );
    },
    async bindBase(input: Guarded<RepositoryWorkspaceBase>) {
      return requireWorkspace(
        await mutate(
          {
            type: "repositoryWorkspaces.bindBase",
            input: {
              workspaceId: input.workspaceId,
              expectedRevision: input.expectedRevision,
              baseCommit: input.baseCommit,
              baseManifestHash: input.baseManifestHash,
              nowMs: now?.(),
            },
          },
          input.assertCurrent,
        ),
      );
    },
    async acceptCheckpoint(input: Guarded<RepositoryWorkspaceCheckpoint>) {
      return requireWorkspace(
        await mutate(
          {
            type: "repositoryWorkspaces.acceptCheckpoint",
            input: {
              workspaceId: input.workspaceId,
              expectedRevision: input.expectedRevision,
              checkpointRef: input.checkpointRef,
              manifestHash: input.manifestHash,
              nowMs: now?.(),
            },
          },
          input.assertCurrent,
        ),
      );
    },
    async delete(
      input: Guarded<{ workspaceId: string; sessionEntryCurrent?: SessionEntryCurrentCheck }>,
    ): Promise<void> {
      const root = artifactPath(input.workspaceId);
      await mutate(
        {
          type: "repositoryWorkspaces.delete",
          input: {
            workspaceId: input.workspaceId,
            sessionEntryCurrentSource: input.sessionEntryCurrent?.source,
          },
        },
        input.assertCurrent,
        {
          sessionEntryCurrent: input.sessionEntryCurrent,
          // The row disappears first: an interrupted cleanup leaves only unowned artifacts.
          afterCommit: () => fs.rm(root, { recursive: true, force: true }),
        },
      );
    },
  };
}

export type SessionRepositoryWorkspaceStore = ReturnType<
  typeof createSessionRepositoryWorkspaceStore
>;

/** Resolve on use so loading admission code does not open shared state. */
export function getSessionRepositoryWorkspaceStore(): SessionRepositoryWorkspaceStore {
  return createSessionRepositoryWorkspaceStore();
}
