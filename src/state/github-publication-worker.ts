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
import type {
  PublicationMutationReceipt,
  PublicationReadOperations,
} from "./github-publication-worker.types.js";
import type { PublicationWorkerOperations } from "./github-publication.worker-contract.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";
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

export async function readGitHubPublicationInWorker(
  command: SqliteWorkerCommand<PublicationReadOperations>,
) {
  const context = captureOpenClawStateReadWorkerContext();
  const captured = structuredClone(command);
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute(captured),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return result;
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
      if (source) {
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
              receipt = readReceipt(facts);
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
      let settled: Promise<unknown> = Promise.resolve();
      const check = () => {
        assertSource();
        assertCurrent();
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
              const mutationAdmission = createSqliteWorkerOperationAdmission(() => {
                throw new Error("GitHub publication bookkeeping requires no source admission.");
              });
              admission = mutationAdmission;
              const retained = withGitHubPublicationWorkerReceipt(
                () => ({
                  admission: mutationAdmission,
                  nativeLocations: [context.admission.databasePath],
                }),
                context,
                (facts) => {
                  const receipt = readReceipt(facts);
                  // Installation precedes observers and is independent of ordinary reply delivery.
                  try {
                    assertSource();
                  } catch {
                    return;
                  }
                  publish(receipt);
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
