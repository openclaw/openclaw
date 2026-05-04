import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function resolveCallerStackSummary(): string | undefined {
  try {
    const stack = new Error().stack?.split("\n").slice(3, 8) ?? [];
    const cleaned = stack
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(process.cwd(), "."));
    return cleaned.length > 0 ? cleaned.join(" | ") : undefined;
  } catch {
    return undefined;
  }
}

const AGENT_EXEC_DEBUG_ENV = "OPENCLAW_AGENT_EXEC_DEBUG";
const AGENT_EXEC_DEBUG_FALLBACK_PATH = "/tmp/openclaw-agent-exec-dispatch-debug.jsonl";
export const AGENT_EXEC_DIRECT_PREWORKSPACE_FALLBACK_PATH =
  "/tmp/openclaw-agent-exec-direct-preworkspace-debug.jsonl";

function readArgValue(flag: string, argv: string[]): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isAgentExecDebugEnabled(): boolean {
  return process.env[AGENT_EXEC_DEBUG_ENV] === "1";
}

export function resolveAgentExecDebugContext(argv: string[] = process.argv): {
  debugPath: string;
  fallbackUsed: boolean;
  jobId?: string;
  jobPath?: string;
  jobFolder?: string;
} {
  const jobId = readArgValue("--job-id", argv);
  const jobPathValue = readArgValue("--job-path", argv);
  if (jobPathValue) {
    const jobPath = path.resolve(jobPathValue);
    const jobFolder = path.dirname(jobPath);
    return {
      debugPath: path.join(jobFolder, ".agent-exec-debug.jsonl"),
      fallbackUsed: false,
      jobId,
      jobPath,
      jobFolder,
    };
  }
  return {
    debugPath: AGENT_EXEC_DEBUG_FALLBACK_PATH,
    fallbackUsed: true,
    jobId,
  };
}

export function appendAgentExecDebug(
  source: string,
  event: string,
  extra: Record<string, unknown> = {},
  argv: string[] = process.argv,
): void {
  if (!isAgentExecDebugEnabled()) {
    return;
  }
  try {
    const context = resolveAgentExecDebugContext(argv);
    fs.appendFileSync(
      context.debugPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        source,
        event,
        job_id: context.jobId,
        job_path: context.jobPath,
        debug_fallback_used: context.fallbackUsed,
        caller_stack_summary: resolveCallerStackSummary(),
        ...extra,
      })}\n`,
    );
  } catch {
    // Debug logging must never change CLI control flow.
  }
}

export function appendAgentExecDualDebug(
  source: string,
  event: string,
  extra: Record<string, unknown> = {},
  argv: string[] = process.argv,
): void {
  if (!isAgentExecDebugEnabled()) {
    return;
  }
  const timestamp = new Date().toISOString();
  const context = resolveAgentExecDebugContext(argv);
  const base = {
    timestamp,
    pid: process.pid,
    source,
    event,
    job_id: context.jobId,
    job_path: context.jobPath,
    job_local_context_exists: !context.fallbackUsed,
    caller_stack_summary: resolveCallerStackSummary(),
    ...extra,
  } as Record<string, unknown>;

  let jobLocalWriteSucceeded = false;
  let jobLocalWriteError: string | undefined;
  if (!context.fallbackUsed) {
    try {
      fs.appendFileSync(context.debugPath, `${JSON.stringify(base)}\n`);
      jobLocalWriteSucceeded = true;
    } catch (error) {
      jobLocalWriteError = error instanceof Error ? error.message : String(error);
    }
  }

  try {
    fs.appendFileSync(
      AGENT_EXEC_DIRECT_PREWORKSPACE_FALLBACK_PATH,
      `${JSON.stringify({
        ...base,
        job_local_write_succeeded: jobLocalWriteSucceeded,
        job_local_write_error: jobLocalWriteError,
        fallback_debug_path: AGENT_EXEC_DIRECT_PREWORKSPACE_FALLBACK_PATH,
        fallback_write_succeeded: true,
      })}\n`,
    );
  } catch {
    // Debug logging must never change CLI control flow.
  }
}
