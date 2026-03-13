// Authored by: cc (Claude Code) | 2026-03-13
import type { CronConfig, CronHookEntry, CronLifecycleHookPoint } from "../config/types.cron.js";
import type { Logger } from "./service/state.js";
import type { CronJob } from "./types.js";

const DEFAULT_PRIORITY = 10;
const HOOK_TIMEOUT_MS = 10_000;

export type CronHookContext = {
  hookPoint: CronLifecycleHookPoint;
  workflow: string;
  job: Pick<CronJob, "id" | "name" | "agentId" | "schedule">;
  result?: unknown;
  error?: string;
  status?: string;
  durationMs?: number;
  /** Mutable bag shared across all hooks in a single job run. */
  meta: Record<string, unknown>;
  log: Logger;
};

export type CronHookRunResult = {
  aborted: boolean;
  reason?: string;
};

/** Resolved entry with a guaranteed numeric priority for sorting. */
type ResolvedEntry = CronHookEntry & { priority: number };

/**
 * Merge global (CronConfig) and per-job hook entries for a given hook point,
 * apply filters, sort by priority, and return the resolved list.
 */
export function loadHookEntries(
  hookPoint: CronLifecycleHookPoint,
  cronConfig: CronConfig | undefined,
  job: CronJob,
  workflow = "cron",
): ResolvedEntry[] {
  const skipGlobal = job.hooks?.skipGlobal?.includes(hookPoint) ?? false;

  // Global entries from openclaw.json cron.hooks section.
  const globalEntries: ResolvedEntry[] = [];
  if (!skipGlobal) {
    const raw = cronConfig?.hooks?.[hookPoint];
    if (raw) {
      for (const entry of raw) {
        if (matchesFilter(entry, job, workflow)) {
          globalEntries.push({ ...entry, priority: entry.priority ?? DEFAULT_PRIORITY });
        }
      }
    }
  }

  // Per-job shorthand entries (string paths, no priority/filter).
  const jobScripts = job.hooks?.[hookPoint];
  const jobEntries: ResolvedEntry[] = [];
  if (jobScripts) {
    for (const script of jobScripts) {
      jobEntries.push({ script, priority: DEFAULT_PRIORITY });
    }
  }

  const merged = [...globalEntries, ...jobEntries];
  // Stable sort: lower priority numbers run first.
  merged.sort((a, b) => a.priority - b.priority);
  return merged;
}

/**
 * Execute hook scripts sequentially for a given lifecycle point.
 * Hook failures are logged but never crash the caller.
 * Only `beforeRun` hooks may abort the job via `{ abort: true, reason }`.
 */
export async function runCronHooks(
  hookPoint: CronLifecycleHookPoint,
  ctx: CronHookContext,
  entries: ResolvedEntry[],
): Promise<CronHookRunResult> {
  if (entries.length === 0) {
    return { aborted: false };
  }

  for (const entry of entries) {
    try {
      const hookFn = await loadHookModule(entry.script);
      if (typeof hookFn !== "function") {
        ctx.log.warn(
          { hookPoint, script: entry.script },
          "cron hook: module does not export a function, skipping",
        );
        continue;
      }

      const timeout = createTimeout(HOOK_TIMEOUT_MS);
      let result: unknown;
      try {
        result = await Promise.race([hookFn(ctx), timeout.promise]);
      } finally {
        timeout.clear();
      }

      // Only beforeRun hooks can abort execution.
      if (hookPoint === "beforeRun" && isAbortResult(result)) {
        const reason =
          "reason" in result && typeof result.reason === "string"
            ? result.reason
            : "aborted by hook";
        ctx.log.info(
          { hookPoint, script: entry.script, reason },
          "cron hook: job aborted by beforeRun hook",
        );
        return { aborted: true, reason };
      }
    } catch (err) {
      ctx.log.warn(
        { hookPoint, script: entry.script, err: String(err) },
        "cron hook: script failed, continuing",
      );
    }
  }

  return { aborted: false };
}

function isAbortResult(value: unknown): value is { abort: boolean; reason?: string } {
  return (
    value != null &&
    typeof value === "object" &&
    "abort" in value &&
    Boolean((value as { abort: unknown }).abort)
  );
}

function matchesFilter(entry: CronHookEntry, job: CronJob, workflow: string): boolean {
  const f = entry.filter;
  if (!f) {
    return true;
  }
  if (f.workflow && f.workflow.length > 0 && !f.workflow.includes(workflow)) {
    return false;
  }
  if (f.jobId && f.jobId.length > 0 && !f.jobId.includes(job.id)) {
    return false;
  }
  // When filter.agentId is set, jobs without an agentId do not match.
  if (f.agentId && f.agentId.length > 0 && (!job.agentId || !f.agentId.includes(job.agentId))) {
    return false;
  }
  return true;
}

async function loadHookModule(scriptPath: string): Promise<unknown> {
  // Dynamic import works for .cjs (via jiti/bun) and .ts files.
  const mod = await import(scriptPath);
  return mod.default ?? mod;
}

function createTimeout(ms: number): { promise: Promise<never>; clear: () => void } {
  let id: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`cron hook timed out after ${ms}ms`)), ms);
  });
  return { promise, clear: () => clearTimeout(id) };
}
