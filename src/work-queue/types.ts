export const WORK_ITEM_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_PRIORITIES = ["critical", "high", "medium", "low"] as const;

export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export type WorkItemActor = {
  sessionKey?: string;
  agentId?: string;
};

export type WorkItemArtifact = {
  type: string;
  path?: string;
  url?: string;
};

export type WorkItemResult = {
  summary?: string;
  outputs?: Record<string, unknown>;
  artifacts?: WorkItemArtifact[];
};

export type WorkItemError = {
  message: string;
  code?: string;
  recoverable?: boolean;
};

export type WorkItem = {
  id: string;
  queueId: string;
  title: string;
  description?: string;
  payload?: Record<string, unknown>;
  status: WorkItemStatus;
  statusReason?: string;
  parentItemId?: string;
  dependsOn?: string[];
  blockedBy?: string[];
  createdBy?: WorkItemActor;
  assignedTo?: WorkItemActor;
  priority: WorkItemPriority;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: WorkItemResult;
  error?: WorkItemError;
};

export type WorkQueue = {
  id: string;
  agentId: string;
  name: string;
  concurrencyLimit: number;
  defaultPriority: WorkItemPriority;
  createdAt: string;
  updatedAt: string;
};

export type WorkQueueStats = {
  pending: number;
  inProgress: number;
  blocked: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
};

export type WorkItemListOptions = {
  queueId?: string;
  status?: WorkItemStatus | WorkItemStatus[];
  priority?: WorkItemPriority | WorkItemPriority[];
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
  assignedTo?: string;
  createdBy?: string;
  parentItemId?: string;
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt" | "priority";
  orderDir?: "asc" | "desc";
};

export type WorkItemPatch = Partial<
  Pick<
    WorkItem,
    | "queueId"
    | "title"
    | "description"
    | "payload"
    | "status"
    | "statusReason"
    | "parentItemId"
    | "dependsOn"
    | "blockedBy"
    | "assignedTo"
    | "priority"
    | "tags"
    | "startedAt"
    | "completedAt"
    | "result"
    | "error"
  >
>;
