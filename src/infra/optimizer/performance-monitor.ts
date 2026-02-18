/**
 * Performance Monitor
 * Tracks system metrics and provides health monitoring
 */

import { EventEmitter } from "node:events";

export interface PerformanceMonitorOptions {
  sampleInterval?: number;
  historyLength?: number;
}

export interface PerformanceStats {
  uptime: {
    ms: number;
    formatted: string;
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  counters: {
    requests: number;
    errors: number;
    cacheHits: number;
    cacheMisses: number;
    messages: number;
  };
  rates: {
    requestsPerSecond: number;
    errorRate: number;
    cacheHitRate: number;
  };
}

export class PerformanceMonitor extends EventEmitter {
  private config: Required<PerformanceMonitorOptions>;
  private startTime = Date.now();
  private counters = {
    requests: 0,
    errors: 0,
    cacheHits: 0,
    cacheMisses: 0,
    messages: 0,
  };
  private samples: Array<{ timestamp: number; memory: NodeJS.MemoryUsage }> = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(options: PerformanceMonitorOptions = {}) {
    super();
    this.config = {
      sampleInterval: options.sampleInterval ?? 5000,
      historyLength: options.historyLength ?? 100,
    };
  }

  start(): void {
    if (this.intervalId) {
      return;
    }
    this.intervalId = setInterval(() => {
      this.sample();
    }, this.config.sampleInterval);
    this.emit("started");
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.emit("stopped");
  }

  private sample(): void {
    const memory = process.memoryUsage();
    this.samples.push({
      timestamp: Date.now(),
      memory,
    });

    if (this.samples.length > this.config.historyLength) {
      this.samples.shift();
    }

    this.emit("sample", { timestamp: Date.now(), memory });
  }

  recordRequest(): void {
    this.counters.requests++;
  }

  recordError(): void {
    this.counters.errors++;
  }

  recordCacheHit(): void {
    this.counters.cacheHits++;
  }

  recordCacheMiss(): void {
    this.counters.cacheMisses++;
  }

  recordMessage(): void {
    this.counters.messages++;
  }

  getStats(): PerformanceStats {
    const now = Date.now();
    const uptime = now - this.startTime;
    const memory = process.memoryUsage();

    const totalCacheOps = this.counters.cacheHits + this.counters.cacheMisses;
    const cacheHitRate = totalCacheOps > 0 ? this.counters.cacheHits / totalCacheOps : 0;

    const errorRate =
      this.counters.requests > 0 ? this.counters.errors / this.counters.requests : 0;

    const requestsPerSecond = uptime > 0 ? (this.counters.requests / uptime) * 1000 : 0;

    return {
      uptime: {
        ms: uptime,
        formatted: this.formatUptime(uptime),
      },
      memory: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        rss: memory.rss,
        external: memory.external,
      },
      counters: { ...this.counters },
      rates: {
        requestsPerSecond,
        errorRate,
        cacheHitRate,
      },
    };
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  reset(): void {
    this.counters = {
      requests: 0,
      errors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      messages: 0,
    };
    this.samples = [];
    this.startTime = Date.now();
    this.emit("reset");
  }
}

let globalMonitor: PerformanceMonitor | null = null;

export function getPerformanceMonitor(options?: PerformanceMonitorOptions): PerformanceMonitor {
  if (!globalMonitor) {
    globalMonitor = new PerformanceMonitor(options);
  }
  return globalMonitor;
}

export function startPerformanceMonitor(options?: PerformanceMonitorOptions): PerformanceMonitor {
  const monitor = getPerformanceMonitor(options);
  monitor.start();
  return monitor;
}

export function stopPerformanceMonitor(): void {
  globalMonitor?.stop();
}
