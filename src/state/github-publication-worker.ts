import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  bindGitHubPublicationSource,
  type GitHubPublicationSourceCapability,
} from "../gateway/github-publication-source.js";
import { placementAuthorityOwnerFor } from "../gateway/worker-environments/placement-authority-owner.js";
import {
  isPublishedPlacementTurnClaimCurrent,
  readPlacementReplica,
} from "../gateway/worker-environments/placement-turn-authority.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withGitHubPublicationWorkerReceipt } from "./github-publication-receipts.js";
import type {
  PublicationMutationReceipt,
  PublicationReadOperations,
} from "./github-publication-worker.types.js";
import type { PublicationWorkerOperations } from "./github-publication.worker-contract.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

type MutationCommand = SqliteWorkerCommand<
  Pick<
    PublicationWorkerOperations,
    | "githubPublications.personal"
    | "githubPublications.gitlabPersonal"
    | "githubPublications.repository"
    | "githubPublications.shared"
    | "githubPublications.insert"
    | "githubPublications.maintenance"
  >
>;

export async function readGitHubPublicationInWorker(
  command: SqliteWorkerCommand<PublicationReadOperations>,
) {
  return await executeExistingOpenClawStateRead({}, command, { current: true });
}

/** A publication execution retains FIFO writes through native settlement. */
export function createGitHubPublicationWorkerScope(context: OpenClawStateWorkerContext) {
  const work = new AsyncWorkScope();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  const assertSource = () => {
    context.admission.assertCurrent();
    if (closed) {
      throw new Error("GitHub publication scope is closed.");
    }
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    assertSource();
    const result = work.track(() =>
      tail.then(() => {
        assertSource();
        return operation();
      }),
    );
    // This lexical owner's observers retain submission order through publication.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    signal: work.signal,
    assertCurrent: assertSource,
    async close() {
      closed = true;
      await work.drain();
    },
    async mutate(
      command: MutationCommand,
      assertCurrent: () => void,
      publish: (receipt: PublicationMutationReceipt) => void,
      source?:
        | GitHubPublicationSourceCapability
        | (() => Promise<GitHubPublicationSourceCapability>),
    ): Promise<PublicationMutationReceipt> {
      const commandSnapshot = structuredClone(command);
      const expectedKind =
        commandSnapshot.type === "githubPublications.insert"
          ? commandSnapshot.input.kind
          : commandSnapshot.type === "githubPublications.gitlabPersonal"
            ? "gitlab-personal"
            : commandSnapshot.type.slice("githubPublications.".length);
      const readReceipt = (facts: unknown): PublicationMutationReceipt => {
        if (
          !isRecord(facts) ||
          facts.operationId !== commandSnapshot.input.operationId ||
          facts.operation !== commandSnapshot.input.operation ||
          !Array.isArray(facts.rows) ||
          facts.kind !== expectedKind
        ) {
          throw new Error("GitHub publication receipt differs from its command.");
        }
        // SAFETY: the private worker response matches its exact dispatched operation.
        return facts as PublicationMutationReceipt;
      };
      return enqueue(async () => {
        if (
          commandSnapshot.type === "githubPublications.shared" &&
          commandSnapshot.input.operation === "defer" &&
          commandSnapshot.input.selection.kind === "orphaned"
        ) {
          const owner = placementAuthorityOwnerFor(context.admission.identity);
          // A release after this snapshot leaves its receipt for the next recovery pass.
          commandSnapshot.input.selection.localClaims = [...owner.localClaimSessions].flatMap(
            (sessionId) => {
              const claim = owner.placements.get(sessionId)?.placement?.turnClaim;
              return claim?.owner === "local" && claim.ownerEpoch === null
                ? [
                    {
                      sessionId,
                      claimId: claim.claimId,
                      runId: claim.runId,
                      placementGeneration: claim.generation,
                    },
                  ]
                : [];
            },
          );
        }
        let retainedSource: GitHubPublicationSourceCapability | undefined;
        try {
          let binding: ReturnType<typeof bindGitHubPublicationSource> | undefined;
          if (source) {
            assertCurrent();
            retainedSource = typeof source === "function" ? await source() : source;
            assertCurrent();
            const request =
              commandSnapshot.type === "githubPublications.insert" &&
              commandSnapshot.input.kind === "shared"
                ? commandSnapshot.input.input
                : undefined;
            const claim = request?.claim;
            binding = bindGitHubPublicationSource(
              retainedSource,
              request && claim?.owner.kind === "local" && claim.owner.environmentId === undefined
                ? () => {
                    const placement = readPlacementReplica(
                      context.admission.identity,
                      claim.sessionId,
                    )?.placement;
                    if (
                      placement?.state !== "local" ||
                      placement.agentId !== request.request.agentId ||
                      placement.sessionKey !== request.request.sessionKey ||
                      !isPublishedPlacementTurnClaimCurrent(context.admission.identity, claim)
                    ) {
                      throw new Error(
                        "GitHub publication turn authority changed before recording.",
                      );
                    }
                  }
                : undefined,
            );
            if (
              binding.context.admission.databasePath !== context.admission.databasePath ||
              binding.context.admission.identity.key !== context.admission.identity.key ||
              binding.context.admission.identity.birthtime !== context.admission.identity.birthtime
            ) {
              throw new Error("GitHub publication destination changed before dispatch.");
            }
          }
          const captured = binding
            ? {
                ...commandSnapshot,
                input: { ...commandSnapshot.input, source: binding.predicate },
              }
            : commandSnapshot;
          const operationContext = binding?.context ?? context;
          let admission: SqliteWorkerOperationAdmission | undefined;
          let receipt: PublicationMutationReceipt | undefined;
          let settled: Promise<unknown> = Promise.resolve();
          const check = () => {
            assertSource();
            if (!binding) {
              assertCurrent();
            }
          };
          return await runOpenClawStateWorkerOperation(
            operationContext,
            async (scope) => {
              const outcome = await scope.execute(captured).then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
              );
              await settled;
              const committed = admission?.committed;
              if (committed) {
                if (binding) {
                  if (!receipt) {
                    throw new Error("GitHub publication committed facts were not installed.");
                  }
                  return receipt;
                }
                return readReceipt(committed.facts);
              }
              if (!outcome.ok) {
                throw outcome.error;
              }
              throw new Error("GitHub publication mutation has no committed receipt.");
            },
            {
              assertCurrent: check,
              createAdmission: (operation) => {
                settled = operation.settled;
                const retained = withGitHubPublicationWorkerReceipt(
                  binding?.createAdmission ??
                    (() => ({
                      admission: createSqliteWorkerOperationAdmission(() => {
                        throw new Error(
                          "GitHub publication bookkeeping requires no source admission.",
                        );
                      }),
                      nativeLocations: [context.admission.databasePath],
                    })),
                  operationContext,
                  (facts) => {
                    receipt = readReceipt(facts);
                    // Installation precedes observers and is independent of ordinary reply delivery.
                    try {
                      assertSource();
                    } catch {
                      return;
                    }
                    publish(receipt);
                  },
                )(operation);
                admission = retained.admission;
                return retained;
              },
            },
          );
        } finally {
          await retainedSource?.release();
        }
      });
    },
  };
}
