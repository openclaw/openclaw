/**
 * Mythos A2A (Agent-to-Agent) Protocol
 * 
 * High-performance communication protocol for multi-agent orchestration.
 * Supports pub/sub, direct messaging, blackboard pattern, and task coordination.
 */

// Import native Rust module
let a2aModule: any = null;
let loadAttempted = false;

async function ensureA2AModule(): Promise<any> {
  if (loadAttempted) return a2aModule;
  loadAttempted = true;

  try {
    a2aModule = await import('@openclaw/mythos-a2a-protocol');
  } catch {
    a2aModule = null;
  }

  return a2aModule;
}

// Type definitions matching Rust types
export interface AgentInfo {
  id: string;
  name: string;
  status: 'idle' | 'busy' | 'blocked' | 'error' | 'offline';
  capabilities: string[];
  registeredAt: number;
  lastHeartbeat: number;
}

export interface A2AMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  messageType: 'request' | 'response' | 'event' | 'task' | 'heartbeat' | 'error';
  topic?: string;
  payload: string;
  timestamp: number;
  correlationId?: string;
  priority: number;
  ttlMs?: number;
}

export interface Task {
  id: string;
  assignedTo: string;
  createdBy: string;
  description: string;
  status: string;
  priority: number;
  createdAt: number;
  updatedAt: number;
  result?: string;
  dependencies: string[];
  metadata?: string;
}

export interface TaskStatistics {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface BlackboardEntry {
  key: string;
  value: string;
  author: string;
}

// Agent Registry
export class AgentRegistry {
  private native: any;

  constructor() {
    const mod = ensureA2AModule();
    if (mod) {
      this.native = new mod.AgentRegistry();
    } else {
      // Fallback to JavaScript implementation
      this.native = this.createFallbackRegistry();
    }
  }

  private createFallbackRegistry() {
    const agents = new Map<string, AgentInfo>();
    const topics = new Map<string, string[]>();

    return {
      registerAgent: (info: AgentInfo) => {
        agents.set(info.id, info);
        return true;
      },
      unregisterAgent: (agentId: string) => {
        return agents.delete(agentId);
      },
      getAgent: (agentId: string) => {
        return agents.get(agentId) || null;
      },
      listAgents: () => {
        return Array.from(agents.values());
      },
      updateAgentStatus: (agentId: string, status: string) => {
        const agent = agents.get(agentId);
        if (agent) {
          agent.status = status as any;
          agent.lastHeartbeat = Date.now();
          return true;
        }
        return false;
      },
      getAgentsByCapability: (capability: string) => {
        return Array.from(agents.values()).filter(a => 
          a.capabilities.includes(capability)
        );
      },
      subscribe: (agentId: string, topic: string) => {
        if (!topics.has(topic)) {
          topics.set(topic, []);
        }
        const subscribers = topics.get(topic)!;
        if (!subscribers.includes(agentId)) {
          subscribers.push(agentId);
        }
        return true;
      },
      unsubscribe: (agentId: string, topic: string) => {
        const subscribers = topics.get(topic);
        if (subscribers) {
          const index = subscribers.indexOf(agentId);
          if (index > -1) {
            subscribers.splice(index, 1);
          }
        }
        return true;
      },
      getSubscribers: (topic: string) => {
        return topics.get(topic) || [];
      }
    };
  }

  async registerAgent(info: AgentInfo): Promise<boolean> {
    return this.native.registerAgent(info);
  }

  async unregisterAgent(agentId: string): Promise<boolean> {
    return this.native.unregisterAgent(agentId);
  }

  async getAgent(agentId: string): Promise<AgentInfo | null> {
    return this.native.getAgent(agentId);
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.native.listAgents();
  }

  async updateAgentStatus(agentId: string, status: string): Promise<boolean> {
    return this.native.updateAgentStatus(agentId, status);
  }

  async getAgentsByCapability(capability: string): Promise<AgentInfo[]> {
    return this.native.getAgentsByCapability(capability);
  }

  async subscribe(agentId: string, topic: string): Promise<boolean> {
    return this.native.subscribe(agentId, topic);
  }

  async unsubscribe(agentId: string, topic: string): Promise<boolean> {
    return this.native.unsubscribe(agentId, topic);
  }

  async getSubscribers(topic: string): Promise<string[]> {
    return this.native.getSubscribers(topic);
  }
}

// Message Router
export class MessageRouter {
  private native: any;
  private messageQueue: Map<string, A2AMessage[]>;

  constructor(private registry: AgentRegistry) {
    const mod = ensureA2AModule();
    if (mod) {
      this.native = new mod.MessageRouter(registry);
    } else {
      this.messageQueue = new Map();
    }
  }

  async sendDirect(message: A2AMessage): Promise<boolean> {
    if (this.native) {
      return this.native.sendDirect(message);
    }

    // Fallback implementation
    const toAgent = message.toAgent;
    const agent = await this.registry.getAgent(toAgent);
    if (!agent) {
      throw new Error(`Agent ${toAgent} not found`);
    }

    if (!this.messageQueue.has(toAgent)) {
      this.messageQueue.set(toAgent, []);
    }
    this.messageQueue.get(toAgent)!.push(message);
    return true;
  }

  async publish(message: A2AMessage): Promise<number> {
    if (this.native) {
      return this.native.publish(message);
    }

    // Fallback implementation
    const topic = message.topic;
    if (!topic) {
      throw new Error('Topic is required for publish');
    }

    const subscribers = await this.registry.getSubscribers(topic);
    let delivered = 0;

    for (const subscriber of subscribers) {
      const msg = { ...message, toAgent: subscriber };
      if (await this.sendDirect(msg)) {
        delivered++;
      }
    }

    return delivered;
  }

  async receive(agentId: string, limit: number = 10): Promise<A2AMessage[]> {
    if (this.native) {
      return this.native.receive(agentId, limit);
    }

    // Fallback implementation
    const queue = this.messageQueue.get(agentId) || [];
    const messages = queue.splice(0, limit);
    return messages;
  }

  async pendingCount(agentId: string): Promise<number> {
    if (this.native) {
      return this.native.pendingCount(agentId);
    }

    return this.messageQueue.get(agentId)?.length || 0;
  }

  async clearQueue(agentId: string): Promise<number> {
    if (this.native) {
      return this.native.clearQueue(agentId);
    }

    const queue = this.messageQueue.get(agentId) || [];
    const count = queue.length;
    this.messageQueue.delete(agentId);
    return count;
  }
}

// Task Coordinator
export class TaskCoordinator {
  private native: any;
  private tasks: Map<string, Task>;

  constructor() {
    const mod = ensureA2AModule();
    if (mod) {
      this.native = new mod.TaskCoordinator();
    } else {
      this.tasks = new Map();
    }
  }

  async createTask(task: Task): Promise<string> {
    if (this.native) {
      return this.native.createTask(task);
    }

    this.tasks.set(task.id, task);
    return task.id;
  }

  async getTask(taskId: string): Promise<Task | null> {
    if (this.native) {
      return this.native.getTask(taskId);
    }

    return this.tasks.get(taskId) || null;
  }

  async updateTaskStatus(
    taskId: string,
    status: string,
    result?: string
  ): Promise<boolean> {
    if (this.native) {
      return this.native.updateTaskStatus(taskId, status, result);
    }

    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;
      task.result = result;
      task.updatedAt = Date.now();
      return true;
    }
    return false;
  }

  async getTasksByStatus(status: string): Promise<Task[]> {
    if (this.native) {
      return this.native.getTasksByStatus(status);
    }

    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  async getTasksByAgent(agentId: string): Promise<Task[]> {
    if (this.native) {
      return this.native.getTasksByAgent(agentId);
    }

    return Array.from(this.tasks.values()).filter(t => t.assignedTo === agentId);
  }

  async areDependenciesMet(taskId: string): Promise<boolean> {
    if (this.native) {
      return this.native.areDependenciesMet(taskId);
    }

    const task = this.tasks.get(taskId);
    if (!task) return false;

    for (const depId of task.dependencies) {
      const depTask = this.tasks.get(depId);
      if (!depTask || depTask.status !== 'completed') {
        return false;
      }
    }
    return true;
  }

  async getReadyTasks(): Promise<Task[]> {
    if (this.native) {
      return this.native.getReadyTasks();
    }

    const ready: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && await this.areDependenciesMet(task.id)) {
        ready.push(task);
      }
    }
    return ready;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    if (this.native) {
      return this.native.cancelTask(taskId);
    }

    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'cancelled';
      task.updatedAt = Date.now();
      return true;
    }
    return false;
  }

  async getStatistics(): Promise<TaskStatistics> {
    if (this.native) {
      return this.native.getStatistics();
    }

    const stats: TaskStatistics = {
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };

    for (const task of this.tasks.values()) {
      stats.total++;
      switch (task.status) {
        case 'pending':
          stats.pending++;
          break;
        case 'in_progress':
          stats.inProgress++;
          break;
        case 'completed':
          stats.completed++;
          break;
        case 'failed':
          stats.failed++;
          break;
        case 'cancelled':
          stats.cancelled++;
          break;
      }
    }

    return stats;
  }
}

// Blackboard (Shared State)
export class Blackboard {
  private native: any;
  private entries: Map<string, { value: string; author: string }>;

  constructor() {
    const mod = ensureA2AModule();
    if (mod) {
      this.native = new mod.Blackboard();
    } else {
      this.entries = new Map();
    }
  }

  async write(key: string, value: string, author: string): Promise<boolean> {
    if (this.native) {
      return this.native.write(key, value, author);
    }

    this.entries.set(key, { value, author });
    return true;
  }

  async read(key: string): Promise<string | null> {
    if (this.native) {
      return this.native.read(key);
    }

    return this.entries.get(key)?.value || null;
  }

  async exists(key: string): Promise<boolean> {
    if (this.native) {
      return this.native.exists(key);
    }

    return this.entries.has(key);
  }

  async delete(key: string): Promise<boolean> {
    if (this.native) {
      return this.native.delete(key);
    }

    return this.entries.delete(key) !== undefined;
  }

  async listKeys(): Promise<string[]> {
    if (this.native) {
      return this.native.listKeys();
    }

    return Array.from(this.entries.keys());
  }

  async getAll(): Promise<BlackboardEntry[]> {
    if (this.native) {
      return this.native.getAll();
    }

    return Array.from(this.entries.entries()).map(([key, { value, author }]) => ({
      key,
      value,
      author
    }));
  }

  async clear(): Promise<number> {
    if (this.native) {
      return this.native.clear();
    }

    const count = this.entries.size;
    this.entries.clear();
    return count;
  }

  async search(pattern: string): Promise<BlackboardEntry[]> {
    if (this.native) {
      return this.native.search(pattern);
    }

    return Array.from(this.entries.entries())
      .filter(([key, { value }]) => 
        key.includes(pattern) || value.includes(pattern)
      )
      .map(([key, { value, author }]) => ({
        key,
        value,
        author
      }));
  }
}

// Utility functions
export async function isA2AAvailable(): Promise<boolean> {
  const mod = await ensureA2AModule();
  return mod !== null;
}

export function createMessage(
  fromAgent: string,
  toAgent: string,
  messageType: A2AMessage['messageType'],
  payload: string,
  options: Partial<A2AMessage> = {}
): A2AMessage {
  return {
    id: crypto.randomUUID(),
    fromAgent,
    toAgent,
    messageType,
    payload,
    timestamp: Date.now(),
    priority: 5,
    ...options
  };
}

export function createTask(
  assignedTo: string,
  createdBy: string,
  description: string,
  options: Partial<Task> = {}
): Task {
  return {
    id: crypto.randomUUID(),
    assignedTo,
    createdBy,
    description,
    status: 'pending',
    priority: 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    dependencies: [],
    ...options
  };
}
