import { appendAuditEvent } from "./audit-trail.js";

export type JobState = "queued" | "running" | "succeeded" | "failed" | "blocked" | "skipped";

export type OrchestrationJob<T = unknown> = {
  id: string;
  key: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  result?: T;
  error?: string;
};

export class OrchestrationQueue {
  private readonly jobs = new Map<string, OrchestrationJob>();

  constructor(private readonly auditFilePath?: string) {}

  enqueue(params: { id: string; key?: string; maxAttempts?: number }): OrchestrationJob {
    const key = params.key ?? params.id;
    const existing = this.findByKey(key);
    if (existing && (existing.state === "queued" || existing.state === "running")) {
      existing.updatedAt = Date.now();
      this.audit("orchestration.job_skipped_idempotent", existing.id, {
        dedupeKey: key,
      });
      return existing;
    }

    const now = Date.now();
    const job: OrchestrationJob = {
      id: params.id,
      key,
      state: "queued",
      attempts: 0,
      maxAttempts: Math.max(1, params.maxAttempts ?? 1),
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.audit("orchestration.job_enqueued", job.id, { dedupeKey: key });
    return job;
  }

  async run<T>(id: string, worker: () => Promise<T>): Promise<OrchestrationJob<T>> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Unknown job: ${id}`);
    }

    while (job.attempts < job.maxAttempts) {
      job.state = "running";
      job.attempts += 1;
      job.updatedAt = Date.now();
      this.audit("orchestration.job_started", job.id, { attempts: job.attempts });

      try {
        const result = await worker();
        job.state = "succeeded";
        job.result = result;
        job.updatedAt = Date.now();
        this.audit("orchestration.job_completed", job.id, { attempts: job.attempts });
        return job as OrchestrationJob<T>;
      } catch (err) {
        job.error = String(err);
        job.updatedAt = Date.now();
        if (job.attempts >= job.maxAttempts) {
          job.state = "failed";
          this.audit("orchestration.job_failed", job.id, {
            attempts: job.attempts,
            error: job.error,
          });
          return job as OrchestrationJob<T>;
        }
      }
    }

    return job as OrchestrationJob<T>;
  }

  getStatus(id: string): OrchestrationJob | undefined {
    return this.jobs.get(id);
  }

  listStatus(): OrchestrationJob[] {
    return [...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private findByKey(key: string): OrchestrationJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.key === key) {
        return job;
      }
    }
    return undefined;
  }

  private audit(type: Parameters<typeof appendAuditEvent>[1]["type"], jobId: string, meta?: Record<string, unknown>) {
    if (!this.auditFilePath) {
      return;
    }
    appendAuditEvent(this.auditFilePath, {
      type,
      jobId,
      meta,
    });
  }
}
