import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import {
  ensureProjectRegistrySchema,
  insertProjectRegistryInDatabase,
  listProjectRegistryInDatabase,
  removeProjectRegistryInDatabase,
  resolveProjectCloneRefreshOwnerInDatabase,
  resolveProjectRegistryInDatabase,
  resolveRecordedProjectRootInDatabase,
} from "./project-registry.kernel.js";
import type {
  ProjectCheckoutLeaseInput,
  ProjectRegistryWorkerOperations,
} from "./project-registry.worker-contract.js";

export function isProjectRegistryCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<ProjectRegistryWorkerOperations> {
  switch (command.type) {
    case "projects.findRoot":
    case "projects.list":
    case "projects.resolve":
    case "projects.insert":
    case "projects.remove":
    case "projects.resolveRefreshOwner":
      return true;
    default:
      return false;
  }
}

export function executeProjectRegistryCommand(
  command: SqliteWorkerCommand<ProjectRegistryWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): ProjectRegistryWorkerOperations[keyof ProjectRegistryWorkerOperations]["output"] {
  if (command.type === "projects.remove") {
    return runCheckoutLeaseTransaction(command.input, options, "projects.registry.remove", (db) =>
      removeProjectRegistryInDatabase(db, command.input.project),
    );
  }
  ensureProjectRegistrySchema(options);
  const db = options.database.db;
  if (command.type === "projects.findRoot") {
    return resolveRecordedProjectRootInDatabase(db, command.input.repoRoot);
  }
  if (command.type === "projects.list") {
    return listProjectRegistryInDatabase(db);
  }
  if (command.type === "projects.resolve") {
    return resolveProjectRegistryInDatabase(db, command.input.id);
  }
  if (command.type === "projects.insert") {
    return runCheckoutLeaseTransaction(command.input, options, "projects.registry.insert", (tx) =>
      insertProjectRegistryInDatabase(tx, command.input.project),
    );
  }
  return runCheckoutLeaseTransaction(
    command.input,
    options,
    "projects.registry.refresh-owner.resolve",
    (tx) => resolveProjectCloneRefreshOwnerInDatabase(tx, command.input.project),
  );
}

// Registry writes are admitted only under the checkout lease for the same repo root.
function runCheckoutLeaseTransaction<T>(
  input: ProjectCheckoutLeaseInput<{ repoRoot: string }>,
  options: OpenClawStateDatabaseOptions,
  operationLabel: string,
  operation: (db: OpenClawStateDatabase["db"]) => T,
): T {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { project, lease } = input;
      if (lease.scope !== "projects.checkout" || lease.key !== project.repoRoot) {
        throw new Error("Project registry write requires its checkout lifecycle lease");
      }
      assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
      return operation(db);
    },
    options,
    { operationLabel },
  );
}
