import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease-store.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import {
  ensureProjectRegistrySchema,
  insertProjectRegistryInDatabase,
  listProjectRegistryInDatabase,
  removeProjectRegistryInDatabase,
  resolveProjectCloneRefreshOwnerInDatabase,
  resolveProjectRegistryInDatabase,
  resolveRecordedProjectRootInDatabase,
  type ProjectRegistryIdentity,
  type ProjectRegistryInsert,
  type ProjectRegistryRecord,
} from "./project-registry.kernel.js";

type ProjectCheckoutLeaseInput<TProject> = {
  project: TProject;
  lease: OpenClawStateLeaseIdentity;
};

export type ProjectRegistryWorkerOperations = {
  "projects.findRoot": { input: { repoRoot: string }; output: string | undefined };
  "projects.list": { input: undefined; output: ProjectRegistryRecord[] };
  "projects.resolve": { input: { id: string }; output: ProjectRegistryRecord | undefined };
  "projects.insert": {
    input: ProjectCheckoutLeaseInput<ProjectRegistryInsert>;
    output: ProjectRegistryRecord;
  };
  "projects.remove": { input: ProjectCheckoutLeaseInput<ProjectRegistryIdentity>; output: boolean };
  "projects.resolveRefreshOwner": {
    input: ProjectCheckoutLeaseInput<ProjectRegistryIdentity>;
    output: ProjectRegistryRecord | undefined;
  };
};

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
  switch (command.type) {
    case "projects.findRoot":
      return resolveRecordedProjectRootInDatabase(db, command.input.repoRoot);
    case "projects.list":
      return listProjectRegistryInDatabase(db);
    case "projects.resolve":
      return resolveProjectRegistryInDatabase(db, command.input.id);
    case "projects.insert":
      return runCheckoutLeaseTransaction(command.input, options, "projects.registry.insert", (tx) =>
        insertProjectRegistryInDatabase(tx, command.input.project),
      );
    case "projects.resolveRefreshOwner":
      return runCheckoutLeaseTransaction(
        command.input,
        options,
        "projects.registry.refresh-owner.resolve",
        (tx) => resolveProjectCloneRefreshOwnerInDatabase(tx, command.input.project),
      );
  }
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
