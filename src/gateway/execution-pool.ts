/**
 * GlobalExecutionPool — Cross-tenant concurrency limiter for cron job execution.
 *
 * Ensures fair resource usage across tenants by limiting:
 * - Total concurrent executions globally (default: 10)
 * - Concurrent executions per tenant (default: 2)
 *
 * Uses round-robin dispatch across tenants to prevent any single tenant
 * from monopolizing execution slots.
 */

type QueuedTask<T = unknown> = {
  tenantId: string;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
};

export type ExecutionPoolOptions = {
  maxGlobalConcurrency?: number;
  maxPerTenantConcurrency?: number;
  queueTimeoutMs?: number;
};

export type ExecutionPoolStats = {
  globalRunning: number;
  maxGlobal: number;
  perTenantRunning: Map<string, number>;
  maxPerTenant: number;
  queueSize: number;
  queueByTenant: Map<string, number>;
};

export class GlobalExecutionPool {
  private readonly maxGlobal: number;
  private readonly maxPerTenant: number;
  private readonly queueTimeoutMs: number;

  private globalRunning = 0;
  private perTenantRunning = new Map<string, number>();
  private queues = new Map<string, QueuedTask[]>();
  /** Round-robin order of tenant IDs with queued work. */
  private tenantOrder: string[] = [];
  private nextTenantIndex = 0;
  private stopped = false;

  constructor(opts: ExecutionPoolOptions = {}) {
    this.maxGlobal = opts.maxGlobalConcurrency ?? 10;
    this.maxPerTenant = opts.maxPerTenantConcurrency ?? 2;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? 5 * 60_000;
  }

  async submit<T>({
    tenantId,
    execute,
  }: {
    tenantId: string;
    execute: () => Promise<T>;
  }): Promise<T> {
    if (this.stopped) {
      throw new Error("ExecutionPool is stopped");
    }

    if (this.canRun(tenantId)) {
      return this.runTask(tenantId, execute);
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        tenantId,
        execute,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      } as unknown as QueuedTask<T>;

      let queue = this.queues.get(tenantId);
      if (!queue) {
        queue = [];
        this.queues.set(tenantId, queue);
        this.tenantOrder.push(tenantId);
      }
      queue.push(task as unknown as QueuedTask);

      setTimeout(() => {
        const q = this.queues.get(tenantId);
        if (q) {
          const idx = q.indexOf(task as unknown as QueuedTask);
          if (idx !== -1) {
            q.splice(idx, 1);
            if (q.length === 0) {
              this.queues.delete(tenantId);
              this.removeTenantFromOrder(tenantId);
            }
            reject(new Error(`Execution queue timeout after ${this.queueTimeoutMs}ms`));
          }
        }
      }, this.queueTimeoutMs);
    });
  }

  getStats(): ExecutionPoolStats {
    let queueSize = 0;
    const queueByTenant = new Map<string, number>();
    for (const [tid, q] of this.queues) {
      queueByTenant.set(tid, q.length);
      queueSize += q.length;
    }
    return {
      globalRunning: this.globalRunning,
      maxGlobal: this.maxGlobal,
      perTenantRunning: new Map(this.perTenantRunning),
      maxPerTenant: this.maxPerTenant,
      queueSize,
      queueByTenant,
    };
  }

  stop() {
    this.stopped = true;
    for (const [, queue] of this.queues) {
      for (const task of queue) {
        task.reject(new Error("ExecutionPool stopped"));
      }
    }
    this.queues.clear();
    this.tenantOrder = [];
  }

  private canRun(tenantId: string): boolean {
    if (this.globalRunning >= this.maxGlobal) {
      return false;
    }
    const tenantCount = this.perTenantRunning.get(tenantId) ?? 0;
    return tenantCount < this.maxPerTenant;
  }

  private async runTask<T>(tenantId: string, execute: () => Promise<T>): Promise<T> {
    this.globalRunning++;
    this.perTenantRunning.set(tenantId, (this.perTenantRunning.get(tenantId) ?? 0) + 1);

    try {
      return await execute();
    } finally {
      this.globalRunning--;
      const count = (this.perTenantRunning.get(tenantId) ?? 1) - 1;
      if (count <= 0) {
        this.perTenantRunning.delete(tenantId);
      } else {
        this.perTenantRunning.set(tenantId, count);
      }
      this.drainNext();
    }
  }

  private drainNext() {
    if (this.stopped || this.tenantOrder.length === 0) {
      return;
    }

    const startIndex = this.nextTenantIndex % this.tenantOrder.length;
    let checked = 0;

    while (checked < this.tenantOrder.length) {
      const idx = (startIndex + checked) % this.tenantOrder.length;
      const tenantId = this.tenantOrder[idx];
      const queue = this.queues.get(tenantId);

      if (!queue || queue.length === 0) {
        this.queues.delete(tenantId);
        this.tenantOrder.splice(idx, 1);
        if (this.tenantOrder.length === 0) {
          return;
        }
        if (idx <= startIndex && checked > 0) {
          checked--;
        }
        continue;
      }

      if (this.canRun(tenantId)) {
        const task = queue.shift()!;
        if (queue.length === 0) {
          this.queues.delete(tenantId);
          this.tenantOrder.splice(idx, 1);
        }
        this.nextTenantIndex =
          this.tenantOrder.length > 0 ? (idx + 1) % this.tenantOrder.length : 0;

        void this.runTask(task.tenantId, task.execute).then(task.resolve, task.reject);
        return;
      }

      checked++;
    }
  }

  private removeTenantFromOrder(tenantId: string) {
    const idx = this.tenantOrder.indexOf(tenantId);
    if (idx !== -1) {
      this.tenantOrder.splice(idx, 1);
      if (this.nextTenantIndex > idx) {
        this.nextTenantIndex--;
      }
      if (this.tenantOrder.length > 0) {
        this.nextTenantIndex = this.nextTenantIndex % this.tenantOrder.length;
      } else {
        this.nextTenantIndex = 0;
      }
    }
  }
}
