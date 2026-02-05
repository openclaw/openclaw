import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkQueueBackend } from "./backend/types.js";
import type {
  WorkItem,
  WorkItemListOptions,
  WorkItemPatch,
  WorkItemPriority,
  WorkItemStatus,
  WorkQueue,
  WorkQueueStats,
} from "./types.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { SqliteWorkQueueBackend } from "./backend/sqlite-backend.js";

const DEFAULT_PRIORITY: WorkItemPriority = "medium";
const DEFAULT_CONCURRENCY = 1;

export type WorkQueueStoreOptions = {
  backend: WorkQueueBackend;
};

export function resolveWorkQueueDbPath(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
}) {
  const stateDir =
    params?.stateDir ?? resolveStateDir(params?.env ?? process.env, params?.homedir ?? os.homedir);
  return path.join(stateDir, "work-queue", "work-queue.sqlite");
}

export class WorkQueueStore {
  private initialized = false;

  constructor(private backend: WorkQueueBackend) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.backend.initialize();
    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.backend.close();
    this.initialized = false;
  }

  private async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private normalizeAgent(agentId: string) {
    return normalizeAgentId(agentId);
  }

  async ensureQueueForAgent(agentId: string, name?: string): Promise<WorkQueue> {
    await this.ensureInitialized();
    const normalized = this.normalizeAgent(agentId);
    const existing = await this.backend.getQueueByAgentId(normalized);
    if (existing) {
      return existing;
    }
    const queue: Omit<WorkQueue, "createdAt" | "updatedAt"> = {
      id: normalized,
      agentId: normalized,
      name: name?.trim() || `${normalized} queue`,
      concurrencyLimit: DEFAULT_CONCURRENCY,
      defaultPriority: DEFAULT_PRIORITY,
    };
    return await this.backend.createQueue(queue);
  }

  async createQueue(queue: Omit<WorkQueue, "createdAt" | "updatedAt">): Promise<WorkQueue> {
    await this.ensureInitialized();
    return await this.backend.createQueue(queue);
  }

  async getQueue(queueId: string): Promise<WorkQueue | null> {
    await this.ensureInitialized();
    return await this.backend.getQueue(queueId);
  }

  async getQueueByAgentId(agentId: string): Promise<WorkQueue | null> {
    await this.ensureInitialized();
    const normalized = this.normalizeAgent(agentId);
    return await this.backend.getQueueByAgentId(normalized);
  }

  async listQueues(opts?: { agentId?: string }): Promise<WorkQueue[]> {
    await this.ensureInitialized();
    const agentId = opts?.agentId ? this.normalizeAgent(opts.agentId) : undefined;
    return await this.backend.listQueues({ agentId });
  }

  async updateQueue(queueId: string, patch: Partial<WorkQueue>): Promise<WorkQueue> {
    await this.ensureInitialized();
    return await this.backend.updateQueue(queueId, patch);
  }

  async deleteQueue(queueId: string): Promise<boolean> {
    await this.ensureInitialized();
    return await this.backend.deleteQueue(queueId);
  }

  async createItem(
    item: Omit<WorkItem, "id" | "createdAt" | "updatedAt" | "queueId" | "status" | "priority"> &
      Partial<Pick<WorkItem, "queueId" | "status" | "priority">> & {
        agentId?: string;
      },
  ): Promise<WorkItem> {
    await this.ensureInitialized();
    const queueId = item.queueId ?? item.agentId;
    if (!queueId) {
      throw new Error("queueId or agentId required");
    }
    const normalized = this.normalizeAgent(queueId);
    const queue = await this.ensureQueueForAgent(normalized);
    const status: WorkItemStatus = item.status ?? "pending";
    const priority: WorkItemPriority = item.priority ?? queue.defaultPriority ?? DEFAULT_PRIORITY;
    return await this.backend.createItem({
      ...item,
      queueId: queue.id,
      status,
      priority,
    });
  }

  async getItem(itemId: string): Promise<WorkItem | null> {
    await this.ensureInitialized();
    return await this.backend.getItem(itemId);
  }

  async listItems(opts: WorkItemListOptions): Promise<WorkItem[]> {
    await this.ensureInitialized();
    return await this.backend.listItems(opts);
  }

  async updateItem(itemId: string, patch: WorkItemPatch): Promise<WorkItem> {
    await this.ensureInitialized();
    return await this.backend.updateItem(itemId, patch);
  }

  async deleteItem(itemId: string): Promise<boolean> {
    await this.ensureInitialized();
    return await this.backend.deleteItem(itemId);
  }

  async claimNextItem(params: {
    queueId?: string;
    agentId?: string;
    assignTo: { sessionKey?: string; agentId?: string };
  }): Promise<WorkItem | null> {
    await this.ensureInitialized();
    const queueId = params.queueId ?? params.agentId;
    if (!queueId) {
      throw new Error("queueId or agentId required");
    }
    const normalized = this.normalizeAgent(queueId);
    await this.ensureQueueForAgent(normalized);
    return await this.backend.claimNextItem(normalized, params.assignTo);
  }

  async getQueueStats(queueId: string): Promise<WorkQueueStats> {
    await this.ensureInitialized();
    return await this.backend.getQueueStats(queueId);
  }
}

let defaultStorePromise: Promise<WorkQueueStore> | null = null;

export async function getDefaultWorkQueueStore(): Promise<WorkQueueStore> {
  if (!defaultStorePromise) {
    defaultStorePromise = (async () => {
      const dbPath = resolveWorkQueueDbPath();
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      const backend = new SqliteWorkQueueBackend(dbPath);
      const store = new WorkQueueStore(backend);
      await store.initialize();
      return store;
    })();
  }
  return await defaultStorePromise;
}

export async function bootstrapWorkQueueForAgent(params: {
  agentId: string;
  sessionKey?: string;
  autoClaim?: boolean;
}): Promise<void> {
  const store = await getDefaultWorkQueueStore();
  await store.ensureQueueForAgent(params.agentId);
  if (params.autoClaim) {
    await store.claimNextItem({
      agentId: params.agentId,
      assignTo: { sessionKey: params.sessionKey, agentId: params.agentId },
    });
  }
}
