import type { DatabaseSync } from "node:sqlite";
import { MinionStore } from "./store.js";
import type {
  ChildDoneMessage,
  ChildFailPolicy,
  InboxMessage,
  MinionJob,
  MinionJobInput,
  MinionJobRow,
  MinionJobStatus,
  MinionQueueOpts,
  TokenUpdate,
} from "./types.js";
import { MINION_TERMINAL_STATUSES, rowToInboxMessage, rowToMinionJob } from "./types.js";

const DEFAULT_MAX_SPAWN_DEPTH = 5;

export class MinionQueue {
  readonly maxSpawnDepth: number;

  constructor(
    private readonly store: MinionStore,
    opts: MinionQueueOpts = {},
  ) {
    this.maxSpawnDepth = opts.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH;
  }

  // ---------------------------------------------------------------------------
  // add — submit a new job
  // ---------------------------------------------------------------------------

  add(name: string, data?: Record<string, unknown>, opts?: Partial<MinionJobInput>): MinionJob {
    if (!name || name.trim().length === 0) {
      throw new Error("Job name cannot be empty");
    }

    const now = Date.now();
    const childStatus: MinionJobStatus = opts?.delay ? "delayed" : "waiting";
    const delayUntil = opts?.delay ? now + opts.delay : null;
    const maxSpawnDepth = opts?.maxSpawnDepth ?? this.maxSpawnDepth;

    return this.store.transaction((db) => {
      if (opts?.idempotencyKey) {
        const existing = db
          .prepare("SELECT * FROM minion_jobs WHERE idempotency_key = ?")
          .all(opts.idempotencyKey) as MinionJobRow[];
        if (existing.length > 0) {
          return rowToMinionJob(existing[0]);
        }
      }

      let depth = 0;
      if (opts?.parentJobId) {
        const parentRows = db
          .prepare("SELECT * FROM minion_jobs WHERE id = ?")
          .all(opts.parentJobId) as MinionJobRow[];
        if (parentRows.length === 0) {
          throw new Error(`parent_job_id ${opts.parentJobId} not found`);
        }
        const parent = rowToMinionJob(parentRows[0]);

        depth = parent.depth + 1;
        if (depth > maxSpawnDepth) {
          throw new Error(`spawn depth ${depth} exceeds maxSpawnDepth ${maxSpawnDepth}`);
        }

        if (parent.maxChildren !== null) {
          const countRow = db
            .prepare(
              `SELECT count(*) AS n FROM minion_jobs
               WHERE parent_job_id = ? AND status NOT IN ('completed','failed','dead','cancelled')`,
            )
            .get(opts.parentJobId) as { n: number | bigint };
          const live = typeof countRow.n === "bigint" ? Number(countRow.n) : countRow.n;
          if (live >= parent.maxChildren) {
            throw new Error(
              `parent ${opts.parentJobId} already has ${live} live children (max_children=${parent.maxChildren})`,
            );
          }
        }
      }

      const dataJson = data != null ? JSON.stringify(data) : null;

      const insertResult = db
        .prepare(
          `INSERT INTO minion_jobs (
            name, queue, status, priority, data,
            max_attempts, backoff_type, backoff_delay, backoff_jitter,
            delay_until, parent_job_id, on_child_fail,
            depth, max_children, timeout_ms,
            remove_on_complete, remove_on_fail, idempotency_key,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?
          )`,
        )
        .run(
          name.trim(),
          opts?.queue ?? "default",
          childStatus,
          opts?.priority ?? 0,
          dataJson,
          opts?.maxAttempts ?? 3,
          opts?.backoffType ?? "exponential",
          opts?.backoffDelay ?? 1000,
          opts?.backoffJitter ?? 0.25,
          delayUntil,
          opts?.parentJobId ?? null,
          opts?.onChildFail ?? "fail_parent",
          depth,
          opts?.maxChildren ?? null,
          opts?.timeoutMs ?? null,
          opts?.removeOnComplete ? 1 : 0,
          opts?.removeOnFail ? 1 : 0,
          opts?.idempotencyKey ?? null,
          now,
          now,
        );

      const insertedId =
        typeof insertResult.lastInsertRowid === "bigint"
          ? Number(insertResult.lastInsertRowid)
          : insertResult.lastInsertRowid;

      if (opts?.parentJobId) {
        db.prepare(
          `UPDATE minion_jobs SET status = 'waiting-children', updated_at = ?
           WHERE id = ? AND status IN ('waiting','active','delayed')`,
        ).run(now, opts.parentJobId);
      }

      const rows = db
        .prepare("SELECT * FROM minion_jobs WHERE id = ?")
        .all(insertedId) as MinionJobRow[];
      return rowToMinionJob(rows[0]);
    });
  }

  // ---------------------------------------------------------------------------
  // read
  // ---------------------------------------------------------------------------

  getJob(id: number): MinionJob | null {
    const rows = this.store.db
      .prepare("SELECT * FROM minion_jobs WHERE id = ?")
      .all(id) as MinionJobRow[];
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  getJobs(opts?: {
    status?: MinionJobStatus;
    queue?: string;
    name?: string;
    limit?: number;
    offset?: number;
  }): MinionJob[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.queue) {
      conditions.push("queue = ?");
      params.push(opts.queue);
    }
    if (opts?.name) {
      conditions.push("name = ?");
      params.push(opts.name);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const rows = this.store.db
      .prepare(
        `SELECT * FROM minion_jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...(params as []), limit, offset) as MinionJobRow[];
    return rows.map(rowToMinionJob);
  }

  // ---------------------------------------------------------------------------
  // claim — atomic claim with lock
  // ---------------------------------------------------------------------------

  claim(
    lockToken: string,
    lockDurationMs: number,
    queue: string,
    registeredNames: string[],
  ): MinionJob | null {
    if (registeredNames.length === 0) {
      return null;
    }

    const now = Date.now();
    const lockUntil = now + lockDurationMs;
    const namePlaceholders = registeredNames.map(() => "?").join(",");

    return this.store.transaction((db) => {
      const candidate = db
        .prepare(
          `SELECT id FROM minion_jobs
           WHERE queue = ? AND status = 'waiting' AND name IN (${namePlaceholders})
           ORDER BY priority DESC, created_at ASC, id ASC
           LIMIT 1`,
        )
        .get(queue, ...registeredNames) as { id: number | bigint } | undefined;

      if (!candidate) {
        return null;
      }

      const jobId = typeof candidate.id === "bigint" ? Number(candidate.id) : candidate.id;

      const rows = db
        .prepare(
          `UPDATE minion_jobs SET
            status = 'active',
            lock_token = ?,
            lock_until = ?,
            timeout_at = CASE WHEN timeout_ms IS NOT NULL
                              THEN ? + timeout_ms
                              ELSE NULL END,
            attempts_started = attempts_started + 1,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
           WHERE id = ? AND status = 'waiting'
           RETURNING *`,
        )
        .all(lockToken, lockUntil, now, now, now, jobId) as MinionJobRow[];

      return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
    });
  }

  // ---------------------------------------------------------------------------
  // complete — with CAS guard, token rollup, child_done inbox, parent resolve
  // ---------------------------------------------------------------------------

  completeJob(
    id: number,
    lockToken: string,
    attemptsMade: number,
    result?: Record<string, unknown>,
  ): MinionJob | null {
    const now = Date.now();
    const resultJson = result != null ? JSON.stringify(result) : null;

    return this.store.transaction((db) => {
      const rows = db
        .prepare(
          `UPDATE minion_jobs SET
            status = 'completed', result = ?,
            finished_at = ?, lock_token = NULL, lock_until = NULL, updated_at = ?
           WHERE id = ? AND status = 'active' AND lock_token = ? AND attempts_made = ?
           RETURNING *`,
        )
        .all(resultJson, now, now, id, lockToken, attemptsMade) as MinionJobRow[];

      if (rows.length === 0) {
        return null;
      }

      const completed = rowToMinionJob(rows[0]);

      if (completed.parentJobId) {
        rollUpTokensToParent(db, completed, now);
        postChildDoneInbox(db, completed, result ?? null, now);
        resolveParentIfDone(db, completed.parentJobId, now);
      }

      if (completed.removeOnComplete) {
        db.prepare("DELETE FROM minion_jobs WHERE id = ?").run(completed.id);
      }

      return completed;
    });
  }

  // ---------------------------------------------------------------------------
  // fail — with CAS guard, retry/dead-letter, parent policy hooks
  // ---------------------------------------------------------------------------

  failJob(
    id: number,
    lockToken: string,
    attemptsMade: number,
    errorText: string,
    newStatus: "delayed" | "failed" | "dead",
    backoffMs?: number,
  ): MinionJob | null {
    const now = Date.now();
    const delayUntil =
      newStatus === "delayed" && backoffMs ? Math.round(now + backoffMs) : null;
    const finishedAt = newStatus === "failed" || newStatus === "dead" ? now : null;

    return this.store.transaction((db) => {
      const current = db
        .prepare("SELECT stacktrace FROM minion_jobs WHERE id = ?")
        .get(id) as { stacktrace: string | null } | undefined;
      const oldTrace: string[] =
        current?.stacktrace ? (JSON.parse(current.stacktrace) as string[]) : [];
      const newTrace = JSON.stringify([...oldTrace, errorText]);

      const rows = db
        .prepare(
          `UPDATE minion_jobs SET
            status = ?, error_text = ?, attempts_made = attempts_made + 1,
            stacktrace = ?,
            delay_until = ?,
            finished_at = ?,
            lock_token = NULL, lock_until = NULL, updated_at = ?
           WHERE id = ? AND status = 'active' AND lock_token = ? AND attempts_made = ?
           RETURNING *`,
        )
        .all(
          newStatus, errorText, newTrace, delayUntil, finishedAt, now,
          id, lockToken, attemptsMade,
        ) as MinionJobRow[];

      if (rows.length === 0) {
        return null;
      }

      const failed = rowToMinionJob(rows[0]);
      const terminal = newStatus === "failed" || newStatus === "dead";

      if (terminal && failed.parentJobId) {
        applyChildFailPolicy(db, failed, errorText, now);
      }

      if (terminal && failed.removeOnFail) {
        db.prepare("DELETE FROM minion_jobs WHERE id = ?").run(failed.id);
      }

      return failed;
    });
  }

  // ---------------------------------------------------------------------------
  // cancel — 2-step recursive CTE with cycle guard per eng review
  // ---------------------------------------------------------------------------

  cancelJob(id: number): MinionJob | null {
    const now = Date.now();

    return this.store.transaction((db) => {
      const descendantRows = db
        .prepare(
          `WITH RECURSIVE descendants(id, d) AS (
            SELECT id, 0 AS d FROM minion_jobs WHERE id = ?
            UNION
            SELECT mj.id, descendants.d + 1
              FROM minion_jobs mj
              JOIN descendants ON mj.parent_job_id = descendants.id
              WHERE descendants.d < ?
          )
          SELECT id FROM descendants`,
        )
        .all(id, this.maxSpawnDepth + 2) as Array<{ id: number | bigint }>;

      if (descendantRows.length === 0) {
        return null;
      }

      const ids = descendantRows.map((r) =>
        typeof r.id === "bigint" ? Number(r.id) : r.id,
      );

      const chunkSize = 500;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(",");
        db.prepare(
          `UPDATE minion_jobs SET
            status = 'cancelled', lock_token = NULL, lock_until = NULL,
            finished_at = ?, updated_at = ?
           WHERE id IN (${placeholders})
             AND status IN ('waiting','active','delayed','waiting-children','paused','attached')`,
        ).run(now, now, ...chunk);
      }

      const rootRows = db
        .prepare("SELECT * FROM minion_jobs WHERE id = ?")
        .all(id) as MinionJobRow[];
      return rootRows.length > 0 ? rowToMinionJob(rootRows[0]) : null;
    });
  }

  // ---------------------------------------------------------------------------
  // retry, remove, pause, resume
  // ---------------------------------------------------------------------------

  retryJob(id: number): MinionJob | null {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET status = 'waiting', error_text = NULL,
          lock_token = NULL, lock_until = NULL, delay_until = NULL,
          finished_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed', 'dead')
         RETURNING *`,
      )
      .all(now, id) as MinionJobRow[];
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  removeJob(id: number): boolean {
    const placeholders = MINION_TERMINAL_STATUSES.map(() => "?").join(",");
    const rows = this.store.db
      .prepare(
        `DELETE FROM minion_jobs WHERE id = ? AND status IN (${placeholders}) RETURNING id`,
      )
      .all(id, ...MINION_TERMINAL_STATUSES);
    return rows.length > 0;
  }

  pauseJob(id: number): MinionJob | null {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET status = 'paused',
          lock_token = NULL, lock_until = NULL, updated_at = ?
         WHERE id = ? AND status IN ('waiting', 'active', 'delayed')
         RETURNING *`,
      )
      .all(now, id) as MinionJobRow[];
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  resumeJob(id: number): MinionJob | null {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET status = 'waiting',
          lock_token = NULL, lock_until = NULL, updated_at = ?
         WHERE id = ? AND status = 'paused'
         RETURNING *`,
      )
      .all(now, id) as MinionJobRow[];
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  // ---------------------------------------------------------------------------
  // lock management
  // ---------------------------------------------------------------------------

  renewLock(id: number, lockToken: string, lockDurationMs: number): boolean {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET lock_until = ?, updated_at = ?
         WHERE id = ? AND lock_token = ? AND status = 'active'
         RETURNING id`,
      )
      .all(now + lockDurationMs, now, id, lockToken);
    return rows.length > 0;
  }

  updateProgress(id: number, lockToken: string, progress: unknown): boolean {
    const now = Date.now();
    const progressJson = JSON.stringify(progress);
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET progress = ?, updated_at = ?
         WHERE id = ? AND status = 'active' AND lock_token = ?
         RETURNING id`,
      )
      .all(progressJson, now, id, lockToken);
    return rows.length > 0;
  }

  updateTokens(id: number, lockToken: string, tokens: TokenUpdate): boolean {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET
          tokens_input = tokens_input + ?,
          tokens_output = tokens_output + ?,
          tokens_cache_read = tokens_cache_read + ?,
          updated_at = ?
         WHERE id = ? AND status = 'active' AND lock_token = ?
         RETURNING id`,
      )
      .all(
        tokens.input ?? 0,
        tokens.output ?? 0,
        tokens.cacheRead ?? 0,
        now,
        id,
        lockToken,
      );
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------
  // sweeps
  // ---------------------------------------------------------------------------

  promoteDelayed(): MinionJob[] {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET status = 'waiting', delay_until = NULL,
          lock_token = NULL, lock_until = NULL, updated_at = ?
         WHERE status = 'delayed' AND delay_until <= ?
         RETURNING *`,
      )
      .all(now, now) as MinionJobRow[];
    return rows.map(rowToMinionJob);
  }

  handleStalled(): { requeued: MinionJob[]; dead: MinionJob[] } {
    const now = Date.now();

    return this.store.transaction((db) => {
      const stalledRows = db
        .prepare(
          `SELECT id, stalled_counter, max_stalled FROM minion_jobs
           WHERE status = 'active' AND lock_until < ?`,
        )
        .all(now) as Array<{
        id: number | bigint;
        stalled_counter: number | bigint;
        max_stalled: number | bigint;
      }>;

      const requeued: MinionJob[] = [];
      const dead: MinionJob[] = [];

      for (const row of stalledRows) {
        const jobId = typeof row.id === "bigint" ? Number(row.id) : row.id;
        const counter =
          typeof row.stalled_counter === "bigint"
            ? Number(row.stalled_counter)
            : row.stalled_counter;
        const maxStalled =
          typeof row.max_stalled === "bigint" ? Number(row.max_stalled) : row.max_stalled;

        if (counter + 1 < maxStalled) {
          const updated = db
            .prepare(
              `UPDATE minion_jobs SET
                status = 'waiting', stalled_counter = stalled_counter + 1,
                lock_token = NULL, lock_until = NULL, updated_at = ?
               WHERE id = ?
               RETURNING *`,
            )
            .all(now, jobId) as MinionJobRow[];
          if (updated.length > 0) {
            requeued.push(rowToMinionJob(updated[0]));
          }
        } else {
          const updated = db
            .prepare(
              `UPDATE minion_jobs SET
                status = 'dead', stalled_counter = stalled_counter + 1,
                error_text = 'max stalled count exceeded',
                lock_token = NULL, lock_until = NULL,
                finished_at = ?, updated_at = ?
               WHERE id = ?
               RETURNING *`,
            )
            .all(now, now, jobId) as MinionJobRow[];
          if (updated.length > 0) {
            dead.push(rowToMinionJob(updated[0]));
          }
        }
      }

      return { requeued, dead };
    });
  }

  handleTimeouts(): MinionJob[] {
    const now = Date.now();
    return this.store.transaction((db) => {
      const rows = db
        .prepare(
          `UPDATE minion_jobs SET
            status = 'dead',
            error_text = 'timeout exceeded',
            lock_token = NULL, lock_until = NULL,
            finished_at = ?, updated_at = ?
           WHERE status = 'active'
             AND timeout_at IS NOT NULL
             AND timeout_at < ?
             AND lock_until > ?
           RETURNING *`,
        )
        .all(now, now, now, now) as MinionJobRow[];

      const jobs = rows.map(rowToMinionJob);
      for (const job of jobs) {
        if (job.parentJobId) {
          applyChildFailPolicy(db, job, "timeout exceeded", now);
        }
      }
      return jobs;
    });
  }

  // ---------------------------------------------------------------------------
  // prune
  // ---------------------------------------------------------------------------

  prune(opts?: {
    olderThanMs?: number;
    statuses?: MinionJobStatus[];
  }): number {
    const statuses = opts?.statuses ?? ["completed", "dead", "cancelled"];
    const cutoff = Date.now() - (opts?.olderThanMs ?? 30 * 86400000);
    const placeholders = statuses.map(() => "?").join(",");

    const result = this.store.db
      .prepare(
        `DELETE FROM minion_jobs
         WHERE status IN (${placeholders}) AND updated_at < ?`,
      )
      .run(...(statuses as []), cutoff);

    return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  }

  // ---------------------------------------------------------------------------
  // stats
  // ---------------------------------------------------------------------------

  getStats(): {
    byStatus: Record<string, number>;
    queueHealth: { waiting: number; active: number; stalled: number };
  } {
    const now = Date.now();

    const statusRows = this.store.db
      .prepare("SELECT status, count(*) AS n FROM minion_jobs GROUP BY status")
      .all() as Array<{ status: string; n: number | bigint }>;

    const byStatus: Record<string, number> = {};
    for (const r of statusRows) {
      byStatus[r.status] = typeof r.n === "bigint" ? Number(r.n) : r.n;
    }

    const stalledRow = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM minion_jobs WHERE status = 'active' AND lock_until < ?",
      )
      .get(now) as { n: number | bigint };
    const stalled = typeof stalledRow.n === "bigint" ? Number(stalledRow.n) : stalledRow.n;

    return {
      byStatus,
      queueHealth: {
        waiting: byStatus.waiting ?? 0,
        active: byStatus.active ?? 0,
        stalled,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // inbox
  // ---------------------------------------------------------------------------

  sendMessage(jobId: number, payload: unknown, sender: string): InboxMessage | null {
    const job = this.getJob(jobId);
    if (!job) {
      return null;
    }
    if (MINION_TERMINAL_STATUSES.includes(job.status as never)) {
      return null;
    }
    if (sender !== "admin" && sender !== "minions" && sender !== String(job.parentJobId)) {
      return null;
    }

    const now = Date.now();
    const payloadJson = JSON.stringify(payload);
    const rows = this.store.db
      .prepare(
        `INSERT INTO minion_inbox (job_id, sender, payload, sent_at)
         VALUES (?, ?, ?, ?)
         RETURNING *`,
      )
      .all(jobId, sender, payloadJson, now);
    return rows.length > 0 ? rowToInboxMessage(rows[0] as never) : null;
  }

  readInbox(jobId: number, lockToken: string): InboxMessage[] {
    const lockCheck = this.store.db
      .prepare(
        "SELECT id FROM minion_jobs WHERE id = ? AND lock_token = ? AND status = 'active'",
      )
      .all(jobId, lockToken);
    if (lockCheck.length === 0) {
      return [];
    }

    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_inbox SET read_at = ?
         WHERE job_id = ? AND read_at IS NULL
         RETURNING *`,
      )
      .all(now, jobId);
    return rows.map((r) => rowToInboxMessage(r as never));
  }

  // ---------------------------------------------------------------------------
  // parent/child helpers
  // ---------------------------------------------------------------------------

  resolveParent(parentId: number): MinionJob | null {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET status = 'waiting', updated_at = ?
         WHERE id = ? AND status = 'waiting-children'
           AND NOT EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE parent_job_id = ?
               AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
           )
         RETURNING *`,
      )
      .all(now, parentId, parentId) as MinionJobRow[];
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  // ---------------------------------------------------------------------------
  // handler_pid
  // ---------------------------------------------------------------------------

  setHandlerPid(id: number, lockToken: string, pid: number): boolean {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `UPDATE minion_jobs SET handler_pid = ?, updated_at = ?
         WHERE id = ? AND lock_token = ? AND status = 'active'
         RETURNING id`,
      )
      .all(pid, now, id, lockToken);
    return rows.length > 0;
  }

  clearHandlerPid(id: number): void {
    const now = Date.now();
    this.store.db
      .prepare("UPDATE minion_jobs SET handler_pid = NULL, updated_at = ? WHERE id = ?")
      .run(now, id);
  }
}

// ---------------------------------------------------------------------------
// internal helpers (not exported)
// ---------------------------------------------------------------------------

function rollUpTokensToParent(db: DatabaseSync, child: MinionJob, now: number): void {
  if (
    child.tokensInput === 0 &&
    child.tokensOutput === 0 &&
    child.tokensCacheRead === 0
  ) {
    return;
  }
  db.prepare(
    `UPDATE minion_jobs SET
      tokens_input = tokens_input + ?,
      tokens_output = tokens_output + ?,
      tokens_cache_read = tokens_cache_read + ?,
      updated_at = ?
     WHERE id = ? AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')`,
  ).run(
    child.tokensInput,
    child.tokensOutput,
    child.tokensCacheRead,
    now,
    child.parentJobId,
  );
}

function postChildDoneInbox(
  db: DatabaseSync,
  child: MinionJob,
  result: unknown,
  now: number,
): void {
  const childDone: ChildDoneMessage = {
    type: "child_done",
    childId: child.id,
    jobName: child.name,
    result,
  };
  db.prepare(
    `INSERT INTO minion_inbox (job_id, sender, payload, sent_at)
     SELECT ?, 'minions', ?, ?
     WHERE EXISTS (
       SELECT 1 FROM minion_jobs
       WHERE id = ? AND status NOT IN ('completed','failed','dead','cancelled')
     )`,
  ).run(child.parentJobId, JSON.stringify(childDone), now, child.parentJobId);
}

function resolveParentIfDone(db: DatabaseSync, parentId: number, now: number): void {
  db.prepare(
    `UPDATE minion_jobs SET status = 'waiting', updated_at = ?
     WHERE id = ? AND status = 'waiting-children'
       AND NOT EXISTS (
         SELECT 1 FROM minion_jobs
         WHERE parent_job_id = ?
           AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
       )`,
  ).run(now, parentId, parentId);
}

function applyChildFailPolicy(
  db: DatabaseSync,
  child: MinionJob,
  errorText: string,
  now: number,
): void {
  const parentId = child.parentJobId!;
  const policy: ChildFailPolicy = child.onChildFail;

  if (policy === "fail_parent") {
    db.prepare(
      `UPDATE minion_jobs SET status = 'failed',
        error_text = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'waiting-children'`,
    ).run(`child job ${child.id} failed: ${errorText}`, now, now, parentId);
  } else if (policy === "remove_dep") {
    db.prepare(
      "UPDATE minion_jobs SET parent_job_id = NULL, updated_at = ? WHERE id = ?",
    ).run(now, child.id);
    resolveParentIfDone(db, parentId, now);
  }
}
