import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import { createWorkerEnvironmentCommitAdmission } from "./store-commit-authority.js";
import { reconcileAttachedSessionOwners } from "./store-mutations.js";
import { createWorkerEnvironmentReceipt } from "./store-receipt.js";
import { readWorkerEnvironmentFacts } from "./store-row-codec.js";
import { readTotalChanges } from "./store-write.js";
import { createWorkerEnvironmentStoreKernel } from "./store.kernel.js";
import type {
  WorkerEnvironmentMutationInput,
  WorkerEnvironmentMutationMethods,
} from "./store.types.js";
import { pruneObservedTerminalWorkerEnvironments } from "./terminal-environment-retention.js";

type Method = keyof WorkerEnvironmentMutationMethods | "initialize";
type Input<Name extends Method> = {
  nowMs?: number;
  publicationIncarnation: string;
} & (Name extends keyof WorkerEnvironmentMutationMethods
  ? { input: WorkerEnvironmentMutationInput<Name> }
  : unknown);
type MutationContext = {
  db: OpenClawStateDatabase["db"];
  store: ReturnType<typeof createWorkerEnvironmentStoreKernel>;
  now: () => number;
  touch: (id: string) => void;
};

function mutation<Name extends Method, Result>(
  name: Name,
  execute: (input: Input<Name>, context: MutationContext) => Result,
) {
  return (input: Input<Name>, { open }: WorkerOperationContext) => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      (transactionDatabase) => {
        const { db } = transactionDatabase;
        const now = () => input.nowMs ?? Date.now();
        const store = createWorkerEnvironmentStoreKernel(transactionDatabase, now);
        const changesBefore = readTotalChanges(db);
        const touched = new Set<string>();
        const result = execute(input, { db, store, now, touch: (id) => touched.add(id.trim()) });
        const facts = readWorkerEnvironmentFacts(db, [...touched]);
        const receipt = {
          result,
          changed: readTotalChanges(db) !== changesBefore,
          publication: createWorkerEnvironmentReceipt(
            {
              identity: requireOpenClawStateDatabaseIdentity({ db }).key,
              incarnation: input.publicationIncarnation,
            },
            facts,
          ),
        };
        deferSqliteWorkerCommitReceipt(db, receipt);
        requestSqliteWorkerOperationAdmission({
          stage: "commit",
          facts: createWorkerEnvironmentCommitAdmission(facts),
        });
        return receipt;
      },
      { database },
      { operationLabel: `workerEnvironments.${name}` },
    );
  };
}

type EnvironmentMethod = Exclude<
  keyof WorkerEnvironmentMutationMethods,
  | "ensureNodeEnrollment"
  | "ensurePreparedIntent"
  | "createSessionAttachmentIntent"
  | "closeSessionAttachment"
  | "pruneTerminalEnvironments"
>;
function environmentMutation<Name extends EnvironmentMethod, Result>(
  name: Name,
  execute: (input: Input<Name>["input"], store: MutationContext["store"]) => Result,
) {
  return mutation(name, ({ input }, { store, touch }) => {
    touch(input.environmentId);
    return execute(input, store);
  });
}

export const workerEnvironmentOperations = {
  "workerEnvironments.initialize": mutation("initialize", (_input, { db, now, touch }) => {
    for (const id of reconcileAttachedSessionOwners(db, now())) {
      touch(id);
    }
    return undefined;
  }),
  "workerEnvironments.createIntent": environmentMutation("createIntent", (input, store) =>
    store.createIntent(input),
  ),
  "workerEnvironments.ensureNodeEnrollment": mutation(
    "ensureNodeEnrollment",
    ({ input }, { store, touch }) => {
      touch(input);
      return store.ensureNodeEnrollment(input);
    },
  ),
  "workerEnvironments.revokeEnvironmentCredential": environmentMutation(
    "revokeEnvironmentCredential",
    (input, store) => store.revokeEnvironmentCredential(input),
  ),
  "workerEnvironments.reconcileSharedHost": environmentMutation(
    "reconcileSharedHost",
    (input, store) => store.reconcileSharedHost(input),
  ),
  "workerEnvironments.adoptProvisionCleanupFailure": environmentMutation(
    "adoptProvisionCleanupFailure",
    (input, store) => store.adoptProvisionCleanupFailure(input),
  ),
  "workerEnvironments.requestDestroy": environmentMutation("requestDestroy", (input, store) =>
    store.requestDestroy(input),
  ),
  "workerEnvironments.refreshBootstrapReceipt": environmentMutation(
    "refreshBootstrapReceipt",
    (input, store) => store.refreshBootstrapReceipt(input),
  ),
  "workerEnvironments.transition": environmentMutation("transition", (input, store) =>
    store.transition(input),
  ),
  "workerEnvironments.renewCredential": environmentMutation("renewCredential", (input, store) =>
    store.renewCredential(input),
  ),
  "workerEnvironments.markCredentialDelivered": environmentMutation(
    "markCredentialDelivered",
    (input, store) => store.markCredentialDelivered(input),
  ),
  "workerEnvironments.recordError": environmentMutation("recordError", (input, store) =>
    store.recordError(input),
  ),
  "workerEnvironments.ensurePreparedIntent": mutation(
    "ensurePreparedIntent",
    ({ input }, { store, touch }) => {
      const value = store.ensurePreparedIntent(input);
      touch(input.intent.environmentId);
      if (value) {
        touch(value.environmentId);
      }
      return value;
    },
  ),
  "workerEnvironments.requestPreparedDestroy": environmentMutation(
    "requestPreparedDestroy",
    (input, store) => store.requestPreparedDestroy(input),
  ),
  "workerEnvironments.createSessionAttachmentIntent": mutation(
    "createSessionAttachmentIntent",
    ({ input }, { store, touch }) => {
      const previous = store.getSessionAttachmentRecord(input.sessionId);
      if (previous) {
        touch(previous.environmentId);
      }
      touch(input.environmentId);
      return store.createSessionAttachmentIntent(input);
    },
  ),
  "workerEnvironments.closeSessionAttachment": mutation(
    "closeSessionAttachment",
    ({ input }, { store, touch }) => {
      const value = store.closeSessionAttachment(input);
      if (value) {
        touch(value.environmentId);
      }
      return value;
    },
  ),
  "workerEnvironments.cancelSessionAttachmentReservation": environmentMutation(
    "cancelSessionAttachmentReservation",
    (input, store) => store.cancelSessionAttachmentReservation(input),
  ),
  "workerEnvironments.touchSessionAttachment": environmentMutation(
    "touchSessionAttachment",
    (input, store) => store.touchSessionAttachment(input),
  ),
  "workerEnvironments.pruneTerminalEnvironments": mutation(
    "pruneTerminalEnvironments",
    ({ input: { approved } }, { db, touch }) => {
      for (const row of approved) {
        touch(row.environment_id);
      }
      return pruneObservedTerminalWorkerEnvironments(db, approved);
    },
  ),
} satisfies WorkerOperationHandlers;
