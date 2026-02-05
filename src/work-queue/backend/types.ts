import type {
  WorkItem,
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
  ): Promise<WorkItem | null>;

  getQueueStats(queueId: string): Promise<WorkQueueStats>;
}
