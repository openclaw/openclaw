import type {
  WorkItem,
  WorkItemExecution,
  WorkItemListOptions,
  WorkItemPatch,
  WorkQueue,
  WorkQueueStats,
} from "../types.js";

export interface WorkQueueBackendTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface WorkQueueBackend {
  initialize(): Promise<void>;
  close(): Promise<void>;

  beginTransaction(): Promise<WorkQueueBackendTransaction>;

  createQueue(queue: Omit<WorkQueue, "createdAt" | "updatedAt">): Promise<WorkQueue>;
  getQueue(queueId: string): Promise<WorkQueue | null>;
  getQueueByAgentId(agentId: string): Promise<WorkQueue | null>;
  listQueues(opts?: { agentId?: string }): Promise<WorkQueue[]>;
  updateQueue(queueId: string, patch: Partial<WorkQueue>): Promise<WorkQueue>;
  deleteQueue(queueId: string): Promise<boolean>;

  createItem(item: Omit<WorkItem, "id" | "createdAt" | "updatedAt">): Promise<WorkItem>;
  getItem(itemId: string): Promise<WorkItem | null>;
  listItems(opts: WorkItemListOptions): Promise<WorkItem[]>;
  updateItem(itemId: string, patch: WorkItemPatch): Promise<WorkItem>;
  deleteItem(itemId: string): Promise<boolean>;

  claimNextItem(
    queueId: string,
    assignTo: { sessionKey?: string; agentId?: string },
    opts?: { workstream?: string },
  ): Promise<WorkItem | null>;

  getQueueStats(queueId: string): Promise<WorkQueueStats>;

  recordExecution(exec: Omit<WorkItemExecution, "id">): Promise<WorkItemExecution>;
  listExecutions(itemId: string, opts?: { limit?: number }): Promise<WorkItemExecution[]>;

  storeTranscript(params: {
    itemId: string;
    executionId?: string;
    sessionKey: string;
    transcript: unknown[];
  }): Promise<string>;
  getTranscript(
    transcriptId: string,
  ): Promise<{ id: string; transcript: unknown[]; sessionKey: string; createdAt: string } | null>;
  listTranscripts(
    itemId: string,
  ): Promise<Array<{ id: string; executionId?: string; sessionKey: string; createdAt: string }>>;
}
