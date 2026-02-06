import type { OpenClawConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { SqliteWorkQueueBackend } from "./backend/sqlite-backend.js";
import type { WorkerMetricsSnapshot } from "./worker-metrics.js";
import { readLatestAssistantReply } from "../agents/tools/agent-step.js";
import { callGateway } from "../gateway/call.js";
import { LlmContextExtractor, TranscriptContextExtractor } from "./context-extractor.js";
import { getDefaultWorkQueueStore } from "./store.js";
import { WorkQueueWorker, type WorkerDeps } from "./worker.js";
import { WorkstreamNotesStore, SqliteWorkstreamNotesBackend } from "./workstream-notes.js";

export type WorkerManagerOptions = {
  config: OpenClawConfig;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
};

const defaultLog = {
  info: (msg: string) => console.log(`[work-queue] ${msg}`),
  warn: (msg: string) => console.warn(`[work-queue] ${msg}`),
  error: (msg: string) => console.error(`[work-queue] ${msg}`),
  debug: (_msg: string) => {},
};

export class WorkQueueWorkerManager {
  private workers = new Map<string, WorkQueueWorker>();
  private config: OpenClawConfig;
  private log: WorkerManagerOptions["log"];
  private notesStore: WorkstreamNotesStore | undefined;

  constructor(opts: WorkerManagerOptions) {
    this.config = opts.config;
    this.log = opts.log ?? defaultLog;
  }

  async start(): Promise<void> {
    const agents = this.config.agents?.list ?? [];
    const workerAgents = agents.filter((a) => a.worker?.enabled);

    if (workerAgents.length === 0) {
      this.log!.debug("no worker agents configured");
      return;
    }

    const store = await getDefaultWorkQueueStore();

    // Try to set up the notes store from the SQLite backend's DB handle.
    this.notesStore = await this.createNotesStore();

    for (const agent of workerAgents) {
      await this.startWorker(agent, store);
    }

    this.log!.info(`started ${this.workers.size} worker(s)`);
  }

  async stop(): Promise<void> {
    const stopPromises = Array.from(this.workers.values()).map((w) => w.stop());
    await Promise.allSettled(stopPromises);
    this.workers.clear();
    this.log!.info("all workers stopped");
  }

  getWorkers(): Array<{
    agentId: string;
    running: boolean;
    currentItemId: string | null;
  }> {
    return Array.from(this.workers.values()).map((w) => ({
      agentId: w.agentId,
      running: w.isRunning,
      currentItemId: w.currentWorkItemId,
    }));
  }

  getMetrics(): WorkerMetricsSnapshot[] {
    return Array.from(this.workers.values()).map((w) => w.getMetrics());
  }

  async reconcile(config: OpenClawConfig): Promise<void> {
    this.config = config;
    const desired = new Set(
      (config.agents?.list ?? []).filter((a) => a.worker?.enabled).map((a) => a.id),
    );

    // Stop removed workers.
    for (const [id, worker] of this.workers) {
      if (!desired.has(id)) {
        await worker.stop();
        this.workers.delete(id);
        this.log!.info(`reconcile: stopped worker ${id}`);
      }
    }

    // Start new / restart changed workers.
    const store = await getDefaultWorkQueueStore();
    for (const agent of (config.agents?.list ?? []).filter((a) => a.worker?.enabled)) {
      const existing = this.workers.get(agent.id);
      if (!existing) {
        await this.startWorker(agent, store);
        this.log!.info(`reconcile: started worker ${agent.id}`);
      } else if (this.configChanged(existing.getConfig(), agent.worker!)) {
        await existing.stop();
        this.workers.delete(agent.id);
        await this.startWorker(agent, store);
        this.log!.info(`reconcile: restarted worker ${agent.id}`);
      }
    }
  }

  private configChanged(
    a: import("../config/types.agents.js").WorkerConfig,
    b: import("../config/types.agents.js").WorkerConfig,
  ): boolean {
    return JSON.stringify(a) !== JSON.stringify(b);
  }

  private async startWorker(
    agent: AgentConfig,
    store: Awaited<ReturnType<typeof getDefaultWorkQueueStore>>,
  ): Promise<void> {
    const workerConfig = agent.worker!;
    const gwCall = <T = Record<string, unknown>>(opts: {
      method: string;
      params?: unknown;
      timeoutMs?: number;
    }) => callGateway<T>({ ...opts, config: this.config });

    const extractor =
      workerConfig.contextExtractor === "llm"
        ? new LlmContextExtractor({
            callGateway: gwCall,
            readFullTranscript: async (params) => {
              const result = await gwCall<{ messages?: unknown[] }>({
                method: "chat.history",
                params: { sessionKey: params.sessionKey, limit: params.limit },
                timeoutMs: 10_000,
              });
              return result?.messages ?? [];
            },
            log: this.log!,
          })
        : new TranscriptContextExtractor({ readLatestAssistantReply });

    const deps: WorkerDeps = {
      store,
      extractor,
      notesStore: this.notesStore,
      callGateway: gwCall,
      log: this.log!,
    };

    const worker = new WorkQueueWorker({
      agentId: agent.id,
      config: workerConfig,
      deps,
    });

    this.workers.set(agent.id, worker);
    await worker.start();
  }

  private async createNotesStore(): Promise<WorkstreamNotesStore | undefined> {
    try {
      const store = await getDefaultWorkQueueStore();
      const backend = store.backend;
      if (
        backend &&
        "getDb" in backend &&
        typeof (backend as SqliteWorkQueueBackend).getDb === "function"
      ) {
        const db = (backend as SqliteWorkQueueBackend).getDb();
        if (db) {
          return new WorkstreamNotesStore(new SqliteWorkstreamNotesBackend(db));
        }
      }
    } catch {
      this.log!.debug("workstream notes store not available (non-sqlite backend)");
    }
    return undefined;
  }
}
