import { randomUUID } from "node:crypto";
import type {
  WorkItem,
  WorkItemListOptions,
  WorkItemPatch,
  WorkItemPriority,
  WorkItemStatus,
  WorkQueue,
  WorkQueueStats,
} from "../types.js";
import type { WorkQueueBackend, WorkQueueBackendTransaction } from "./types.js";

const priorityRank: Record<WorkItemPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function normalizeArray<T>(value?: T | T[]): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function matchesTags(candidate: string[] | undefined, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) {
    return true;
  }
  if (!candidate || candidate.length === 0) {
    return false;
  }
  return tags.every((tag) => candidate.includes(tag));
}

function applyPatch(item: WorkItem, patch: WorkItemPatch): WorkItem {
  return {
    ...item,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export class MemoryWorkQueueBackend implements WorkQueueBackend {
  private queues = new Map<string, WorkQueue>();
  private items = new Map<string, WorkItem>();

  async initialize(): Promise<void> {}

  async close(): Promise<void> {}

  async beginTransaction(): Promise<WorkQueueBackendTransaction> {
    return {
      async commit() {},
      async rollback() {},
    };
  }

  async createQueue(queue: Omit<WorkQueue, "createdAt" | "updatedAt">): Promise<WorkQueue> {
    const now = new Date().toISOString();
    const created: WorkQueue = {
      ...queue,
      createdAt: now,
      updatedAt: now,
    };
    this.queues.set(created.id, created);
    return created;
  }

  async getQueue(queueId: string): Promise<WorkQueue | null> {
    return this.queues.get(queueId) ?? null;
  }

  async getQueueByAgentId(agentId: string): Promise<WorkQueue | null> {
    for (const queue of this.queues.values()) {
      if (queue.agentId === agentId) {
        return queue;
      }
    }
    return null;
  }

  async listQueues(opts?: { agentId?: string }): Promise<WorkQueue[]> {
    const agentId = opts?.agentId?.trim();
    const queues = Array.from(this.queues.values());
    if (!agentId) {
      return queues;
    }
    return queues.filter((queue) => queue.agentId === agentId);
  }

  async updateQueue(queueId: string, patch: Partial<WorkQueue>): Promise<WorkQueue> {
    const current = this.queues.get(queueId);
    if (!current) {
      throw new Error(`Queue not found: ${queueId}`);
    }
    const updated: WorkQueue = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.queues.set(queueId, updated);
    return updated;
  }

  async deleteQueue(queueId: string): Promise<boolean> {
    const removed = this.queues.delete(queueId);
    if (!removed) {
      return false;
    }
    for (const [id, item] of this.items.entries()) {
      if (item.queueId === queueId) {
        this.items.delete(id);
      }
    }
    return true;
  }

  async createItem(item: Omit<WorkItem, "id" | "createdAt" | "updatedAt">): Promise<WorkItem> {
    const now = new Date().toISOString();
    const created: WorkItem = {
      ...item,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(created.id, created);
    return created;
  }

  async getItem(itemId: string): Promise<WorkItem | null> {
    return this.items.get(itemId) ?? null;
  }

  async listItems(opts: WorkItemListOptions): Promise<WorkItem[]> {
    const status = normalizeArray(opts.status);
    const priority = normalizeArray(opts.priority);
    const orderBy = opts.orderBy ?? "createdAt";
    const orderDir = opts.orderDir ?? "asc";
    const filtered = Array.from(this.items.values())
      .filter((item) => (opts.queueId ? item.queueId === opts.queueId : true))
      .filter((item) => (status ? status.includes(item.status) : true))
      .filter((item) => (priority ? priority.includes(item.priority) : true))
      .filter((item) => (opts.createdAfter ? item.createdAt >= opts.createdAfter : true))
      .filter((item) => (opts.createdBefore ? item.createdAt <= opts.createdBefore : true))
      .filter((item) => (opts.assignedTo ? item.assignedTo?.agentId === opts.assignedTo : true))
      .filter((item) => (opts.createdBy ? item.createdBy?.agentId === opts.createdBy : true))
      .filter((item) => (opts.parentItemId ? item.parentItemId === opts.parentItemId : true))
      .filter((item) => matchesTags(item.tags, opts.tags));

    const sorted = filtered.sort((a, b) => {
      if (orderBy === "priority") {
        return priorityRank[a.priority] - priorityRank[b.priority];
      }
      const aValue = orderBy === "updatedAt" ? a.updatedAt : a.createdAt;
      const bValue = orderBy === "updatedAt" ? b.updatedAt : b.createdAt;
      return aValue.localeCompare(bValue);
    });

    if (orderDir === "desc") {
      sorted.reverse();
    }

    const offset = Math.max(0, opts.offset ?? 0);
    const limit = opts.limit ? Math.max(1, opts.limit) : undefined;
    const sliced = limit ? sorted.slice(offset, offset + limit) : sorted.slice(offset);
    return sliced;
  }

  async updateItem(itemId: string, patch: WorkItemPatch): Promise<WorkItem> {
    const current = this.items.get(itemId);
    if (!current) {
      throw new Error(`Work item not found: ${itemId}`);
    }
    const updated = applyPatch(current, patch);
    this.items.set(itemId, updated);
    return updated;
  }

  async deleteItem(itemId: string): Promise<boolean> {
    return this.items.delete(itemId);
  }

  async claimNextItem(
    queueId: string,
    assignTo: { sessionKey?: string; agentId?: string },
  ): Promise<WorkItem | null> {
    const queue = this.queues.get(queueId);
    if (!queue) {
      return null;
    }
    const inProgress = Array.from(this.items.values()).filter(
      (item) => item.queueId === queueId && item.status === "in_progress",
    );
    if (inProgress.length >= queue.concurrencyLimit) {
      return null;
    }
    const pending = Array.from(this.items.values())
      .filter((item) => item.queueId === queueId && item.status === "pending")
      .sort((a, b) => {
        const rank = priorityRank[a.priority] - priorityRank[b.priority];
        if (rank !== 0) {
          return rank;
        }
        return a.createdAt.localeCompare(b.createdAt);
      });

    const next = pending[0];
    if (!next) {
      return null;
    }

    const now = new Date().toISOString();
    const updated: WorkItem = {
      ...next,
      status: "in_progress",
      assignedTo: assignTo,
      startedAt: now,
      updatedAt: now,
    };
    this.items.set(updated.id, updated);
    return updated;
  }

  async getQueueStats(queueId: string): Promise<WorkQueueStats> {
    const items = Array.from(this.items.values()).filter((item) => item.queueId === queueId);
    const stats: WorkQueueStats = {
      pending: 0,
      inProgress: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: items.length,
    };
    for (const item of items) {
      if (item.status === "pending") {
        stats.pending += 1;
      } else if (item.status === "in_progress") {
        stats.inProgress += 1;
      } else if (item.status === "blocked") {
        stats.blocked += 1;
      } else if (item.status === "completed") {
        stats.completed += 1;
      } else if (item.status === "failed") {
        stats.failed += 1;
      } else if (item.status === "cancelled") {
        stats.cancelled += 1;
      }
    }
    return stats;
  }
}
