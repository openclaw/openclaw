import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  bindGitHubPublicationSource,
  type GitHubPublicationSourceCapability,
} from "../gateway/github-publication-source.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withGitHubPublicationWorkerReceipt } from "./github-publication-receipts.js";
import type { PublicationMutationReceipt } from "./github-publication-worker.types.js";
import type { PublicationWorkerOperations } from "./github-publication.worker-contract.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

type MutationCommand = SqliteWorkerCommand<
  Pick<
    PublicationWorkerOperations,
    | "githubPublications.personal"
    | "githubPublications.repository"
    | "githubPublications.shared"
    | "githubPublications.insert"
  >
>;

/** A publication execution retains FIFO writes and fences unknown outcomes until settlement. */
export function createGitHubPublicationWorkerScope(context: OpenClawStateWorkerContext) {
  const pending = new Set<PublicationMutationReceipt>();
  const work = new AsyncWorkScope();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  let uncertain = false;
  const assertSource = () => {
    context.admission.assertCurrent();
    if (closed) {
      throw new Error("GitHub publication scope is closed.");
    }
  };
  const assertReady = () => {
    assertSource();
    if (pending.size || uncertain) {
      throw new Error("GitHub publication facts are pending settlement.");
    }
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    assertSource();
    const result = work.track(() =>
      tail.then(() => {
        assertReady();
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
    assertCurrent: assertReady,
    assertLifetimeCurrent: assertSource,
    async close() {
      closed = true;
      await work.drain();
      pending.clear();
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
      if (source) {
        const expectedKind =
          command.type === "githubPublications.insert"
            ? command.input.kind
            : command.type.slice("githubPublications.".length);
        return enqueue(async () => {
          let retainedSource: GitHubPublicationSourceCapability | undefined;
          try {
            assertCurrent();
            retainedSource = typeof source === "function" ? await source() : source;
            assertCurrent();
            const binding = bindGitHubPublicationSource(retainedSource);
            if (
              binding.context.admission.databasePath !== context.admission.databasePath ||
              binding.context.admission.identity.key !== context.admission.identity.key ||
              binding.context.admission.identity.birthtime !== context.admission.identity.birthtime
            ) {
              throw new Error("GitHub publication destination changed before dispatch.");
            }
            const captured = structuredClone({
              ...commandSnapshot,
              input: { ...commandSnapshot.input, source: binding.predicate },
            });
            let admission: SqliteWorkerOperationAdmission | undefined;
            let receipt: PublicationMutationReceipt | undefined;
            let settled: Promise<unknown> = Promise.resolve();
            const accept = (facts: unknown) => {
              if (
                !isRecord(facts) ||
                facts.operationId !== captured.input.operationId ||
                facts.operation !== captured.input.operation ||
                !Array.isArray(facts.rows) ||
                facts.kind !== expectedKind
              ) {
                throw new Error("GitHub publication source receipt differs from its command.");
              }
              // SAFETY: the private worker response is checked against its exact dispatched operation.
              receipt = facts as PublicationMutationReceipt;
              try {
                assertSource();
              } catch {
                return;
              }
              publish(receipt);
            };
            return await runOpenClawStateWorkerOperation(
              binding.context,
              async (scope) => {
                const outcome = await scope.execute(captured).then(
                  () => ({ ok: true as const }),
                  (error: unknown) => ({ ok: false as const, error }),
                );
                await settled;
                uncertain = admission?.settlement?.kind === "unknown" && !admission.committed;
                if (admission?.committed) {
                  if (!receipt) {
                    throw new Error("GitHub publication committed facts were not installed.");
                  }
                  return receipt;
                }
                if (!outcome.ok) {
                  throw outcome.error;
                }
                throw new Error("GitHub publication mutation has no committed receipt.");
              },
              {
                assertCurrent: assertSource,
                createAdmission(operation) {
                  settled = operation.settled;
                  const retained = withGitHubPublicationWorkerReceipt(
                    binding.createAdmission,
                    binding.context,
                    accept,
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
      }
      const captured = commandSnapshot;
      let admission: SqliteWorkerOperationAdmission | undefined;
      let prepared: PublicationMutationReceipt | undefined;
      let granted = false;
      let settled: Promise<unknown> = Promise.resolve();
      const check = () => {
        assertSource();
        assertCurrent();
        assertSource();
      };
      return enqueue(() =>
        runOpenClawStateWorkerOperation(
          context,
          async (scope) => {
            const outcome = await scope.execute(captured).then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            );
            await settled;
            const committed = admission?.committed;
            if (committed) {
              if (!prepared || !isDeepStrictEqual(committed.facts, prepared)) {
                throw new Error("GitHub publication commit receipt changed.");
              }
              // Accepted results settle even after action revocation; retired scopes never publish.
              try {
                assertSource();
              } catch {
                pending.delete(prepared);
                return prepared;
              }
              pending.delete(prepared);
              return prepared;
            }
            if (prepared && (!granted || admission?.settlement?.kind === "completed")) {
              pending.delete(prepared);
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
              let stage: "transaction" | "commit" | "complete" = "transaction";
              const mutationAdmission = createSqliteWorkerOperationAdmission((request, grant) => {
                check();
                if (request.stage !== stage) {
                  throw new Error("GitHub publication admission is out of order.");
                }
                if (request.stage === "commit") {
                  const facts = request.facts;
                  if (
                    !isRecord(facts) ||
                    facts.operationId !== captured.input.operationId ||
                    facts.operation !== captured.input.operation ||
                    !Array.isArray(facts.rows) ||
                    facts.kind !==
                      (captured.type === "githubPublications.insert"
                        ? captured.input.kind
                        : captured.type.slice("githubPublications.".length))
                  ) {
                    throw new Error("GitHub publication mutation facts differ from its command.");
                  }
                  // SAFETY: the private admitted command supplies the typed postimages after identity checks.
                  prepared = facts as PublicationMutationReceipt;
                  pending.add(prepared);
                  check();
                  granted = grant();
                  stage = "complete";
                } else {
                  grant();
                  stage = "commit";
                }
              });
              admission = mutationAdmission;
              const retained = withGitHubPublicationWorkerReceipt(
                () => ({
                  admission: mutationAdmission,
                  nativeLocations: [context.admission.databasePath],
                }),
                context,
                (facts) => {
                  if (!prepared || !isDeepStrictEqual(facts, prepared)) {
                    throw new Error("GitHub publication commit receipt changed.");
                  }
                  // Installation precedes observers and is independent of ordinary reply delivery.
                  try {
                    assertSource();
                  } catch {
                    return;
                  }
                  publish(prepared);
                },
              )(operation);
              return retained;
            },
          },
        ),
      );
    },
  };
}
