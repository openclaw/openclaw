import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionRequest,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../../state/openclaw-state-worker-store.types.js";

type Publication = { commit(): void; rollback(): void; invalidate(): void };

/** Admission fences precede the native commit; only its receipt publishes authority. */
export function createPlacementWorkerMutation<Receipt>(params: {
  context: OpenClawStateWorkerContext;
  label: string;
  nativeLocation: string;
  orderedAdmission?: boolean;
  assertCurrent?: () => void;
  assertGrantCurrent?: () => void;
  admissionFacts?(request: SqliteWorkerAdmissionRequest): unknown;
  stageCommit(facts: unknown): Publication | undefined;
  readReceipt(facts: unknown, publication: Publication | undefined): Receipt | undefined;
  publish?(receipt: Receipt): void;
  recoverUnknown?(
    error: unknown,
    publication: Publication | undefined,
  ): Promise<Receipt | undefined> | Receipt | undefined;
}) {
  let admission: SqliteWorkerOperationAdmission | undefined;
  let publication: Publication | undefined;
  let transactionGranted = false;
  let commitGranted = false;
  let published = false;
  let installed = false;
  const check = () => {
    params.context.admission.assertCurrent();
    params.assertCurrent?.();
  };
  const install = () => {
    if (!installed) {
      publication?.commit();
      installed = true;
    }
  };
  const publish = (receipt: Receipt) => {
    install();
    if (!published) {
      published = true;
      params.publish?.(receipt);
    }
    return receipt;
  };
  return {
    get transactionGranted() {
      return transactionGranted;
    },
    get commitGranted() {
      return commitGranted;
    },
    get settlement() {
      return admission?.settlement;
    },
    async run(operation: (scope: DomainScope) => Promise<Receipt>): Promise<Receipt> {
      try {
        return await runOpenClawStateWorkerOperation(
          params.context,
          async (scope) => publish(await operation(scope)),
          {
            assertCurrent: check,
            createAdmission: () => {
              let stage: "transaction" | "commit" = "transaction";
              admission = createSqliteWorkerOperationAdmission((request, grant) => {
                if (params.orderedAdmission && request.stage !== stage) {
                  throw new Error(`${params.label} admission is out of order`);
                }
                params.context.admission.assertCurrent();
                (params.assertGrantCurrent ?? params.assertCurrent)?.();
                const facts = params.admissionFacts
                  ? params.admissionFacts(request)
                  : request.facts;
                if (request.stage === "commit") {
                  publication = params.stageCommit(facts) ?? publication;
                }
                if (!grant()) {
                  publication?.rollback();
                  throw new Error(`${params.label} admission expired`);
                }
                transactionGranted ||= request.stage === "transaction";
                commitGranted ||= request.stage === "commit";
                stage = "commit";
              });
              observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
                const receipt = params.readReceipt(facts, publication);
                if (receipt === undefined) {
                  publication?.invalidate();
                  throw new Error(`${params.label} committed receipt is invalid`);
                }
                // Settlement-dependent waiters must not enqueue work on a transport whose reply
                // can still fail; committed authority itself is already available to consumers.
                install();
              });
              return { nativeLocations: [params.nativeLocation], admission };
            },
          },
        );
      } catch (error) {
        const committed = admission?.committed ?? admission?.settlement?.committed;
        if (committed) {
          const receipt = params.readReceipt(committed.facts, publication);
          if (receipt !== undefined) {
            return publish(receipt);
          }
        }
        if (!commitGranted || admission?.settlement?.kind === "completed") {
          publication?.rollback();
        } else if (params.recoverUnknown) {
          const receipt = await params.recoverUnknown(error, publication);
          if (receipt !== undefined) {
            return publish(receipt);
          }
        } else {
          publication?.invalidate();
        }
        throw error;
      }
    },
  };
}
