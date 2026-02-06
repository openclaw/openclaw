export type WorkerMetricsSnapshot = {
  agentId: string;
  totalProcessed: number;
  totalFailed: number;
  totalSucceeded: number;
  averageProcessingTimeMs: number;
  lastProcessingTimeMs?: number;
  currentItemId: string | null;
  currentItemStartedAt?: string;
  uptimeMs: number;
  consecutiveErrors: number;
  startedAt: string;
};

export class WorkerMetrics {
  private totalProcessed = 0;
  private totalSucceeded = 0;
  private totalFailed = 0;
  private totalDurationMs = 0;
  private lastDurationMs?: number;
  private errors = 0;
  private readonly constructedAt = Date.now();
  private readonly startedAtIso = new Date().toISOString();

  recordProcessing(durationMs: number, success: boolean): void {
    this.totalProcessed++;
    this.totalDurationMs += durationMs;
    this.lastDurationMs = durationMs;
    if (success) {
      this.totalSucceeded++;
      this.errors = 0;
    } else {
      this.totalFailed++;
      this.errors++;
    }
  }

  snapshot(agentId: string, currentItemId: string | null): WorkerMetricsSnapshot {
    return {
      agentId,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      totalSucceeded: this.totalSucceeded,
      averageProcessingTimeMs:
        this.totalProcessed > 0 ? Math.round(this.totalDurationMs / this.totalProcessed) : 0,
      lastProcessingTimeMs: this.lastDurationMs,
      currentItemId,
      uptimeMs: Date.now() - this.constructedAt,
      consecutiveErrors: this.errors,
      startedAt: this.startedAtIso,
    };
  }
}
