import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease-store.js";
import type {
  ProjectRegistryIdentity,
  ProjectRegistryInsert,
  ProjectRegistryRecord,
} from "./project-registry.kernel.js";

export type ProjectCheckoutLeaseInput<TProject> = {
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
