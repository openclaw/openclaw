import type { EngineConnection } from "../infra/sql-connection.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../state/worker-operation-registry.js";
import {
  ensureProjectRegistrySchema,
  insertProjectRegistryInDatabase,
  removeProjectCheckoutReferenceInDatabase,
  removeProjectRegistryInDatabase,
  resolveProjectCloneRefreshOwnerInDatabase,
  resolveProjectRegistryInDatabase,
  resolveRecordedProjectRootInDatabase,
} from "./project-registry.kernel.js";

// Registry writes are admitted only under the checkout lease for the same repo root.
function checkoutTransaction<Project extends { repoRoot: string }, Output>(
  operationLabel: string,
  operation: (db: EngineConnection, project: Project) => Output,
) {
  return (
    { project, lease }: { project: Project; lease: OpenClawStateLeaseIdentity },
    { open, stateOptions }: WorkerOperationContext,
  ): Output => {
    const database = open();
    const options = { database, ...stateOptions() };
    ensureProjectRegistrySchema(options);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (lease.scope !== "projects.checkout" || lease.key !== project.repoRoot) {
          throw new Error("Project registry write requires its checkout lifecycle lease");
        }
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
        return operation(db, project);
      },
      options,
      { operationLabel },
    );
  };
}

function registryDatabase({ open, stateOptions }: WorkerOperationContext): EngineConnection {
  const database = open();
  ensureProjectRegistrySchema({ database, ...stateOptions() });
  return database.db;
}

export const projectRegistryOperations = {
  "projects.findRoot": (input: { repoRoot: string }, context) =>
    resolveRecordedProjectRootInDatabase(registryDatabase(context), input.repoRoot),
  "projects.resolve": (input: { id: string }, context) =>
    resolveProjectRegistryInDatabase(registryDatabase(context), input.id),
  "projects.insert": checkoutTransaction(
    "projects.registry.insert",
    insertProjectRegistryInDatabase,
  ),
  "projects.remove": checkoutTransaction(
    "projects.registry.remove",
    removeProjectRegistryInDatabase,
  ),
  "projects.resolveRefreshOwner": checkoutTransaction(
    "projects.registry.refresh-owner.resolve",
    resolveProjectCloneRefreshOwnerInDatabase,
  ),
  "projects.removeCheckoutReference": checkoutTransaction(
    "projects.registry.checkout-reference.remove",
    removeProjectCheckoutReferenceInDatabase,
  ),
} satisfies WorkerOperationHandlers;
