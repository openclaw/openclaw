import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { workspaceJournalOperations } from "./placement-workspace-journal.worker.js";

export type WorkspaceJournalWorkerOperations = WorkerOperations<typeof workspaceJournalOperations>;
