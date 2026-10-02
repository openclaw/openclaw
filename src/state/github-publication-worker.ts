import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { PublicationMutationReceipt } from "./github-publication-worker.types.js";
import type { PublicationWorkerOperations } from "./github-publication.worker-contract.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

type MutationCommand = SqliteWorkerCommand<
  Pick<PublicationWorkerOperations, "githubPublications.personal" | "githubPublications.repository">
>;

/** Inactive lexical publication scope. PR3 supplies its runtime/episode authority and consumers. */
export function createGitHubPublicationWorkerScope(context: OpenClawStateWorkerContext) {
  const pending = new Set<PublicationMutationReceipt>();
  const work = new AsyncWorkScope();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  const assertSource = () => {
    context.admission.assertCurrent();
    if (closed) {
      throw new Error("GitHub publication scope is closed.");
    }
  };
  const assertReady = () => {
    assertSource();
    if (pending.size) {
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
    assertCurrent: assertReady,
    async close() {
      closed = true;
      await work.drain();
      pending.clear();
    },
    prepare<
      Key extends "githubPublications.prepareRepository" | "githubPublications.preparePersonal",
    >(
      command: { type: Key; input: PublicationWorkerOperations[Key]["input"] },
      assertCurrent: () => void,
    ) {
      const captured = structuredClone(command);
      return enqueue(async () => {
        const result = await runOpenClawStateWorkerOperation(
          context,
          (scope) => scope.execute(captured),
          { assertCurrent },
        );
        assertReady();
        assertCurrent();
        assertReady();
        return result;
      });
    },
    async mutate(
      command: MutationCommand,
      assertCurrent: () => void,
      publish: (receipt: PublicationMutationReceipt) => void,
    ): Promise<PublicationMutationReceipt> {
      const captured = structuredClone(command);
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
              publish(prepared);
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
              admission = createSqliteWorkerOperationAdmission((request, grant) => {
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
                      (captured.type === "githubPublications.personal" ? "personal" : "repository")
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
              return { admission, nativeLocations: [context.admission.databasePath] };
            },
          },
        ),
      );
    },
  };
}
