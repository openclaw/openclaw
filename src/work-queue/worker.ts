import { randomUUID } from "node:crypto";
import type { WorkerConfig } from "../config/types.agents.js";
import type { WorkContextExtractor, WorkItemCarryoverContext } from "./context-extractor.js";
import type { WorkQueueStore } from "./store.js";
import type { WorkItem, WorkItemOutcome } from "./types.js";
import type { WorkstreamNotesStore } from "./workstream-notes.js";
import { WorkerMetrics, type WorkerMetricsSnapshot } from "./worker-metrics.js";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_SESSION_TIMEOUT_S = 300;
const MAX_CONSECUTIVE_ERRORS = 5;
const BACKOFF_BASE_MS = 2000;

const APPROVAL_PATTERN = /approval|exec.*approv/i;

export type WorkerDeps = {
  store: WorkQueueStore;
  extractor: WorkContextExtractor;
  notesStore?: WorkstreamNotesStore;
  callGateway: <T = Record<string, unknown>>(opts: {
    method: string;
    params?: unknown;
    timeoutMs?: number;
  }) => Promise<T>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
};

export type WorkerOptions = {
  agentId: string;
  config: WorkerConfig;
  deps: WorkerDeps;
};

export class WorkQueueWorker {
  private abortController = new AbortController();
  private running = false;
  private consecutiveErrors = 0;
  private currentItemId: string | null = null;
  private carryoverContext: WorkItemCarryoverContext | undefined;
  private loopPromise: Promise<void> | null = null;
  private metrics = new WorkerMetrics();

  readonly agentId: string;
  private readonly config: WorkerConfig;
  private readonly deps: WorkerDeps;

  constructor(opts: WorkerOptions) {
    this.agentId = opts.agentId;
    this.config = opts.config;
    this.deps = opts.deps;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentWorkItemId(): string | null {
    return this.currentItemId;
  }

  getConfig(): WorkerConfig {
    return this.config;
  }

  getMetrics(): WorkerMetricsSnapshot {
    return this.metrics.snapshot(this.agentId, this.currentItemId);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.deps.log.info(`worker[${this.agentId}]: starting`);
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.deps.log.info(`worker[${this.agentId}]: stopping`);
    this.running = false;
    this.abortController.abort();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
  }

  private async loop(): Promise<void> {
    const signal = this.abortController.signal;
    const pollMs = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    while (this.running && !signal.aborted) {
      try {
        const item = await this.claimNext();
        if (!item) {
          await this.sleep(pollMs, signal);
          continue;
        }

        this.consecutiveErrors = 0;
        this.currentItemId = item.id;
        this.deps.log.info(`worker[${this.agentId}]: processing item ${item.id} "${item.title}"`);

        const startTime = Date.now();
        const result = await this.processItem(item);
        const durationMs = Date.now() - startTime;

        // Determine outcome.
        const outcome = this.classifyOutcome(result);

        // Record execution.
        const retryCount = (item.retryCount ?? 0) + 1;
        const now = new Date().toISOString();
        const exec = await this.deps.store.recordExecution({
          itemId: item.id,
          attemptNumber: retryCount,
          sessionKey: result.sessionKey ?? "",
          outcome,
          error: result.error,
          startedAt: item.startedAt ?? now,
          completedAt: now,
          durationMs,
        });

        // Archive transcript if available.
        if (result.transcript) {
          await this.deps.store
            .storeTranscript({
              itemId: item.id,
              executionId: exec.id,
              sessionKey: result.sessionKey ?? "",
              transcript: result.transcript,
            })
            .catch((err: unknown) => {
              this.deps.log.debug(
                `worker[${this.agentId}]: transcript archival failed: ${String(err)}`,
              );
            });
        }

        // Update item based on outcome.
        if (outcome === "success") {
          await this.deps.store.updateItem(item.id, {
            status: "completed",
            retryCount,
            lastOutcome: "success",
            result: {
              summary: result.context?.summary,
              outputs: result.context?.outputs,
            },
            completedAt: now,
          });
          this.deps.log.info(`worker[${this.agentId}]: completed item ${item.id}`);
        } else {
          await this.handleFailure(item, outcome, retryCount, result.error, now);
        }

        this.metrics.recordProcessing(durationMs, outcome === "success");
        this.carryoverContext = result.context;
        this.currentItemId = null;

        // Append workstream notes if available.
        if (result.context?.keyFindings && item.workstream && this.deps.notesStore) {
          for (const finding of result.context.keyFindings) {
            await this.deps.notesStore.append({
              workstream: item.workstream,
              itemId: item.id,
              kind: "finding",
              content: finding,
              createdBy: { agentId: this.agentId },
            });
          }
        }
      } catch (err) {
        this.currentItemId = null;
        this.consecutiveErrors++;
        this.deps.log.error(
          `worker[${this.agentId}]: loop error (${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${String(err)}`,
        );
        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          const backoff =
            BACKOFF_BASE_MS * 2 ** Math.min(this.consecutiveErrors - MAX_CONSECUTIVE_ERRORS, 5);
          this.deps.log.warn(
            `worker[${this.agentId}]: backoff ${backoff}ms after ${this.consecutiveErrors} consecutive errors`,
          );
          await this.sleep(backoff, signal);
        }
      }
    }
  }

  private classifyOutcome(result: ProcessItemResult): WorkItemOutcome {
    if (result.status === "ok") return "success";
    if (result.error && APPROVAL_PATTERN.test(result.error)) return "approval_timeout";
    if (result.deadlineExceeded) return "timeout";
    return "error";
  }

  private async handleFailure(
    item: WorkItem,
    outcome: WorkItemOutcome,
    retryCount: number,
    error: string | undefined,
    now: string,
  ): Promise<void> {
    const maxRetries = item.maxRetries ?? 0;
    const exhausted = maxRetries > 0 && retryCount >= maxRetries;

    if (exhausted) {
      await this.deps.store.updateItem(item.id, {
        status: "failed",
        retryCount,
        lastOutcome: outcome,
        statusReason: `max retries exceeded (${retryCount}/${maxRetries})`,
        error: { message: error ?? "unknown error", recoverable: false },
        completedAt: now,
      });
      this.deps.log.warn(
        `worker[${this.agentId}]: item ${item.id} exhausted retries (${retryCount}/${maxRetries})`,
      );
    } else if (maxRetries > 0) {
      // Return to pending for retry.
      await this.deps.store.updateItem(item.id, {
        status: "pending",
        retryCount,
        lastOutcome: outcome,
        statusReason: `retry ${retryCount}/${maxRetries}`,
        error: { message: error ?? "unknown error", recoverable: true },
        assignedTo: undefined,
        startedAt: undefined,
        completedAt: undefined,
      });
      this.deps.log.info(
        `worker[${this.agentId}]: item ${item.id} returned to pending for retry ${retryCount}/${maxRetries}`,
      );
    } else {
      // No retry configured.
      await this.deps.store.updateItem(item.id, {
        status: "failed",
        retryCount,
        lastOutcome: outcome,
        error: { message: error ?? "unknown error", recoverable: true },
        completedAt: now,
      });
      this.deps.log.warn(`worker[${this.agentId}]: failed item ${item.id}: ${error}`);
    }
  }

  private async claimNext(): Promise<WorkItem | null> {
    const workstreams = this.config.workstreams;
    if (workstreams && workstreams.length > 0) {
      // Try each workstream in order.
      for (const ws of workstreams) {
        const item = await this.deps.store.claimNextItem({
          agentId: this.agentId,
          assignTo: { agentId: this.agentId },
          workstream: ws,
        });
        if (item) return item;
      }
      return null;
    }
    return this.deps.store.claimNextItem({
      agentId: this.agentId,
      assignTo: { agentId: this.agentId },
    });
  }

  private async processItem(item: WorkItem): Promise<ProcessItemResult> {
    // Deadline check — fail early if past deadline.
    if (item.deadline && Date.now() > new Date(item.deadline).getTime()) {
      return { status: "error", error: "deadline exceeded", deadlineExceeded: true };
    }

    const runId = randomUUID();
    const sessionKey = `agent:${this.agentId}:worker:${item.id}:${runId.slice(0, 8)}`;
    const timeoutS = this.config.sessionTimeoutSeconds ?? DEFAULT_SESSION_TIMEOUT_S;

    const systemPrompt = await this.buildSystemPrompt(item);

    // Spawn the agent session.
    const spawnResult = await this.deps.callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: this.buildTaskMessage(item),
        sessionKey,
        idempotencyKey: runId,
        deliver: false,
        lane: "worker",
        extraSystemPrompt: systemPrompt,
        thinking: this.config.thinking ?? undefined,
        timeout: timeoutS,
        label: `Worker: ${item.title}`,
        spawnedBy: `worker:${this.agentId}`,
      },
      timeoutMs: 10_000,
    });

    const actualRunId = spawnResult?.runId ?? runId;

    // Wait for the session to complete.
    const waitResult = await this.deps.callGateway<{
      status?: string;
      error?: string;
    }>({
      method: "agent.wait",
      params: {
        runId: actualRunId,
        timeoutMs: timeoutS * 1000,
      },
      timeoutMs: timeoutS * 1000 + 5000,
    });

    const runStatus = waitResult?.status === "ok" ? "ok" : "error";
    const runError =
      waitResult?.error ?? (runStatus === "error" ? "session failed or timed out" : undefined);

    // Extract context from completed session.
    const context = await this.deps.extractor.extract({
      sessionKey,
      item,
      runResult: { status: runStatus, error: runError },
      previousContext: this.carryoverContext,
    });

    // Read transcript before deleting session.
    let transcript: unknown[] | undefined;
    try {
      const historyResult = await this.deps.callGateway<{
        messages?: unknown[];
      }>({
        method: "chat.history",
        params: { sessionKey, limit: 500 },
        timeoutMs: 10_000,
      });
      transcript = historyResult?.messages;
    } catch (err) {
      this.deps.log.debug(`worker[${this.agentId}]: transcript read failed: ${String(err)}`);
    }

    // Clean up the session.
    await this.deps
      .callGateway({
        method: "sessions.delete",
        params: { key: sessionKey, deleteTranscript: true },
        timeoutMs: 10_000,
      })
      .catch((err: unknown) => {
        this.deps.log.debug(`worker[${this.agentId}]: session cleanup failed: ${String(err)}`);
      });

    return { status: runStatus, error: runError, context, sessionKey, transcript };
  }

  private async buildSystemPrompt(item: WorkItem): Promise<string> {
    const parts: string[] = [];

    parts.push("## Worker Task");
    parts.push(`**Title:** ${item.title}`);
    if (item.description) {
      parts.push(`**Description:** ${item.description}`);
    }
    if (item.workstream) {
      parts.push(`**Workstream:** ${item.workstream}`);
    }
    if (item.payload && Object.keys(item.payload).length > 0) {
      parts.push(`**Payload:**\n\`\`\`json\n${JSON.stringify(item.payload, null, 2)}\n\`\`\``);
    }

    // Inject workstream notes if available.
    if (item.workstream && this.deps.notesStore) {
      try {
        const notes = this.deps.notesStore.list(item.workstream, { limit: 10 });
        if (notes.length > 0) {
          const notesSummary = this.deps.notesStore.summarize(notes, { maxChars: 2000 });
          if (notesSummary) {
            parts.push("");
            parts.push(notesSummary);
          }
        }
      } catch {
        // Notes injection is best-effort.
      }
    }

    if (this.carryoverContext?.summary) {
      parts.push("");
      parts.push("## Previous Task Context");
      parts.push(this.carryoverContext.summary);
    }

    parts.push("");
    parts.push("## Instructions");
    parts.push(
      "Complete the task described above. When finished, summarize what you accomplished in your final message.",
    );

    return parts.join("\n");
  }

  private buildTaskMessage(item: WorkItem): string {
    let msg = item.title;
    if (item.description) {
      msg += `\n\n${item.description}`;
    }
    return msg;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

type ProcessItemResult = {
  status: "ok" | "error";
  error?: string;
  context?: WorkItemCarryoverContext;
  sessionKey?: string;
  transcript?: unknown[];
  deadlineExceeded?: boolean;
};
