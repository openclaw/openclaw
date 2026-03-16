// Authored by: cc (Claude Code) | 2026-03-13
import path from "node:path";
import type { CronConfig, CronHookEntry, CronLifecycleHookPoint } from "../config/types.cron.js";
import { importFileModule, resolveFunctionModuleExport } from "../hooks/module-loader.js";
import { resolveUserPath } from "../utils.js";
import type { Logger } from "./service/state.js";
import type { CronJob, CronPayload } from "./types.js";

const DEFAULT_PRIORITY = 10;
const HOOK_TIMEOUT_MS = 10_000;

export type CronHookContext = {
  hookPoint: CronLifecycleHookPoint;
  workflow: string;
  job: Pick<CronJob, "id" | "name" | "agentId" | "schedule">;
  /** The job's payload for this run. Hook scripts can inspect kind/command/message to make decisions. */
  payload: CronPayload;
  error?: string;
  status?: string;
  durationMs?: number;
  /**
   * Mutable bag shared across all hooks in a single job run.
   * Hooks can write values here for downstream hooks to read (e.g. audit IDs, timestamps).
   */
  meta: Record<string, unknown>;
  log: Logger;
  /** Base directory for resolving relative hook script paths (defaults to cwd). */
  basePath?: string;
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
  // Per-job entries are validated to prevent path traversal since jobs.json
  // may be more accessible than openclaw.json.
  const jobScripts = job.hooks?.[hookPoint];
  const jobEntries: ResolvedEntry[] = [];
  if (jobScripts) {
    for (const script of jobScripts) {
      if (!isValidJobHookPath(script)) {
        continue;
      }
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
      const hookFn = await loadHookModule(entry.script, ctx.basePath);
      if (typeof hookFn !== "function") {
        ctx.log.warn(
          { hookPoint, script: entry.script },
          "cron hook: module does not export a function, skipping",
        );
        continue;
      }

      const timeoutMs = entry.timeoutMs ?? HOOK_TIMEOUT_MS;
      const timeout = createTimeout(timeoutMs);
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
      // Use error level for runtime failures; warn for missing modules.
      const isModuleError =
        err instanceof Error &&
        (err.message.includes("Cannot find module") || err.message.includes("MODULE_NOT_FOUND"));
      const logFn = isModuleError ? ctx.log.warn : ctx.log.error;
      logFn.call(
        ctx.log,
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
  // jobName filter: case-insensitive substring match against the job's name.
  if (f.jobName && f.jobName.length > 0) {
    const nameLower = job.name.toLowerCase();
    if (!f.jobName.some((pattern) => nameLower.includes(pattern.toLowerCase()))) {
      return false;
    }
  }
  // When filter.agentId is set, jobs without an agentId do not match.
  if (f.agentId && f.agentId.length > 0 && (!job.agentId || !f.agentId.includes(job.agentId))) {
    return false;
  }
  return true;
}

async function loadHookModule(scriptPath: string, basePath?: string): Promise<unknown> {
  // Check isAbsolute before the URL-scheme regex: Windows drive-letter paths like
  // "C:\hooks\audit.cjs" match /^[a-z][a-z0-9+.-]*:/ and must not be treated as URLs.
  if (!path.isAbsolute(scriptPath) && /^[a-z][a-z0-9+.-]*:/i.test(scriptPath)) {
    // URL-scheme specifiers (file://, data:, etc.) are passed through directly.
    const mod = (await import(scriptPath)) as Record<string, unknown>;
    return mod.default ?? mod;
  }
  // Resolve via resolveUserPath: handles ~ expansion and resolves relative paths
  // against the provided base (OC home) instead of process.cwd().
  const resolved = resolveUserPath(scriptPath, process.env, undefined, basePath);
  const mod = await importFileModule({ modulePath: resolved, cacheBust: true });
  return resolveFunctionModuleExport({ mod, fallbackExportNames: ["default"] });
}

/**
 * Validate that a per-job hook script path does not escape the base directory
 * via path traversal (e.g. "../../secrets.env"). Global hooks from openclaw.json
 * are admin-controlled and not subject to this restriction.
 */
export function isValidJobHookPath(scriptPath: string): boolean {
  // Reject absolute paths and traversal segments in per-job entries.
  if (path.isAbsolute(scriptPath)) {
    return false;
  }
  // Reject URL-scheme specifiers (npm:, node:, data:, https:, etc.) — per-job
  // hooks must be relative filesystem paths. Global hooks in openclaw.json are
  // admin-controlled and may use any specifier.
  if (/^[a-z][a-z0-9+.-]*:/i.test(scriptPath)) {
    return false;
  }
  const normalized = path.normalize(scriptPath);
  if (normalized.startsWith("..")) {
    return false;
  }
  return true;
}

function createTimeout(ms: number): { promise: Promise<never>; clear: () => void } {
  let id: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`cron hook timed out after ${ms}ms`)), ms);
  });
  return { promise, clear: () => clearTimeout(id) };
}
