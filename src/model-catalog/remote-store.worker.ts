import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import { readRemoteModelCatalog } from "./remote-store.js";

export const modelCatalogOperations = {
  "modelCatalog.remote.read": (
    input: { artifactPreservingReadOnly: boolean },
    { stateOptions },
  ) => {
    const read = () => readRemoteModelCatalog(stateOptions());
    return input.artifactPreservingReadOnly ? withArtifactPreservingStateReads(read) : read();
  },
} satisfies WorkerOperationHandlers;

export type ModelCatalogWorkerOperations = WorkerOperations<typeof modelCatalogOperations>;
