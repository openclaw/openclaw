import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import type { WorkerOperationContext } from "../state/worker-operation-registry.js";
import { readClawInstallSchemaVersionRows } from "./provenance-runtime-read.kernel.js";

export const clawInstallSchemaOperations = {
  "claws.install-schema-versions": (
    input: { artifactPreservingReadOnly: boolean },
    context: WorkerOperationContext,
  ) => {
    const read = input.artifactPreservingReadOnly
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
      : withExistingOpenClawStateDatabaseReadOnly;
    return read(({ db, path: pathname }) => {
      assertOpenClawStateDatabaseOwner(db, { pathname });
      return readClawInstallSchemaVersionRows(db);
    }, context.stateOptions());
  },
};
