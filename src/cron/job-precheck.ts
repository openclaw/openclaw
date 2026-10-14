import { spawn } from "node:child_process";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { killProcessTree } from "../process/kill-tree.js";
import {
  authorizeCronJobPrecheckCommand,
  type CronJobPrecheckAuthz,
} from "./job-precheck-authz.js";
import {
  PRECHECK_ERROR_REASON,
  PRECHECK_INVALID_REASON,
  PRECHECK_NO_WORK_REASON,
  PRECHECK_SKIPPED_ERROR_REASON,
  PRECHECK_TIMEOUT_REASON,
  resolvePrecheckExecEnv,
  resolveTrustedPrecheckShellCommand,
} from "./job-precheck-shared.js";
import { createCronRunDiagnosticsFromError } from "./run-diagnostics.js";
import type { CronJobPrecheck } from "./types-shared.js";
import type { CronRunDiagnostics, CronRunOutcome } from "./types.js";

export { authorizeCronJobPrecheckCommand } from "./job-precheck-authz.js";
export {
  PRECHECK_NO_WORK_REASON,
  PRECHECK_POLICY_DENIED_REASON,
  PRECHECK_SKIPPED_ERROR_REASON,
  resolveTrustedPrecheckShellCommand,
  cronToolsAllowPermitsPrecheckExec,
} from "./job-precheck-shared.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_CAPTURE_CHARS = 4_000;

/** Result of evaluating a cron job precheck gate (no model involved). */
type CronJobPrecheckResult =
  | { decision: "run"; exitCode: number | null; stdout: string; stderr: string }
  | {
      decision: "skip";
      reason: typeof PRECHECK_NO_WORK_REASON | typeof PRECHECK_SKIPPED_ERROR_REASON;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }
  | {
      decision: "error";
      reason: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };

function clip(text: string, max = MAX_CAPTURE_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

function resolveTimeoutMs(precheck: CronJobPrecheck): number {
  const raw = precheck.timeoutMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Parse a finish/line-oriented precheck protocol from command output.
 * Prefer exit codes when contract is exit-code; begin-line prefixes always win when present.
 */
export function interpretPrecheckOutput(params: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  contract?: CronJobPrecheck["contract"];
  workExitCodes?: number[];
  noWorkExitCodes?: number[];
  workStdoutPrefix?: string;
  noWorkStdoutPrefix?: string;
  onError?: CronJobPrecheck["onError"];
}): CronJobPrecheckResult {
  const stdout = params.stdout ?? "";
  const stderr = params.stderr ?? "";
  const head = stdout.trimStart();
  // Empty prefixes must never match (String#startsWith("") is always true).
  const workPrefixRaw = params.workStdoutPrefix ?? "WORK_NEEDED";
  const noWorkPrefixRaw = params.noWorkStdoutPrefix ?? "NO_WORK";
  const workPrefix = workPrefixRaw.trim().length > 0 ? workPrefixRaw : "WORK_NEEDED";
  const noWorkPrefix = noWorkPrefixRaw.trim().length > 0 ? noWorkPrefixRaw : "NO_WORK";

  if (noWorkPrefix.length > 0 && head.startsWith(noWorkPrefix)) {
    return {
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: params.exitCode,
      stdout,
      stderr,
    };
  }
  if (workPrefix.length > 0 && head.startsWith(workPrefix)) {
    return { decision: "run", exitCode: params.exitCode, stdout, stderr };
  }

  const contract = params.contract ?? "exit-code";
  const workCodes = params.workExitCodes?.length ? params.workExitCodes : [0];
  const noWorkCodes = params.noWorkExitCodes?.length ? params.noWorkExitCodes : [2];
  const code = params.exitCode ?? 1;

  if (contract === "stdout-prefix") {
    // No recognized prefix — treat as error unless exit 0 and empty = no work.
    if (code === 0 && !stdout.trim()) {
      return {
        decision: "skip",
        reason: PRECHECK_NO_WORK_REASON,
        exitCode: code,
        stdout,
        stderr,
      };
    }
    return {
      decision: "error",
      reason: `${PRECHECK_ERROR_REASON}: stdout did not start with ${workPrefix} or ${noWorkPrefix}`,
      exitCode: code,
      stdout,
      stderr,
    };
  }

  // exit-code (default) or dual when no prefix matched
  if (noWorkCodes.includes(code)) {
    return {
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: code,
      stdout,
      stderr,
    };
  }
  if (workCodes.includes(code)) {
    return { decision: "run", exitCode: code, stdout, stderr };
  }

  const onError = params.onError ?? "fail";
  if (onError === "skip") {
    return {
      decision: "skip",
      reason: PRECHECK_SKIPPED_ERROR_REASON,
      exitCode: code,
      stdout,
      stderr,
    };
  }
  return {
    decision: "error",
    reason: `${PRECHECK_ERROR_REASON}: unexpected exit code ${code}`,
    exitCode: code,
    stdout,
    stderr,
  };
}

export async function runCronJobPrecheck(
  precheck: CronJobPrecheck,
  opts?: {
    abortSignal?: AbortSignal;
    spawnImpl?: typeof spawn;
    /** Required for host execution: triggers + exec security policy. */
    authz?: CronJobPrecheckAuthz;
    /**
     * Durable run-receipt / currency fence. Invoked immediately after awaited
     * authorization and before host spawn so a mutation during authz cannot
     * still reach the shell (ClawSweeper P1).
     */
    assertRunCurrent?: () => void;
  },
): Promise<CronJobPrecheckResult> {
  const command = normalizeOptionalString(precheck.command) ?? "";
  if (!command) {
    return {
      decision: "error",
      reason: `${PRECHECK_INVALID_REASON}: empty command`,
      exitCode: null,
      stdout: "",
      stderr: "",
    };
  }

  if (opts?.abortSignal?.aborted) {
    return {
      decision: "error",
      reason: PRECHECK_TIMEOUT_REASON,
      exitCode: null,
      stdout: "",
      stderr: "aborted",
    };
  }

  const cwd = normalizeOptionalString(precheck.cwd) || undefined;

  // Fail closed: without authz (or explicitly allow via tests spawn only),
  // production timer path always passes authz. Direct API callers must pass it.
  const authz: CronJobPrecheckAuthz = opts?.authz ?? {
    triggersEnabled: false,
    security: "deny",
    securityOverrideOnly: true,
  };
  const auth = await authorizeCronJobPrecheckCommand({
    command,
    cwd,
    authz,
  });
  if (!auth.allowed) {
    return {
      decision: "error",
      reason: auth.reason,
      exitCode: null,
      stdout: "",
      stderr: auth.reason,
    };
  }

  // Recheck cancellation after awaited authorization — cancel during authz must
  // not still spawn a host shell (ClawSweeper P1).
  if (opts?.abortSignal?.aborted) {
    return {
      decision: "error",
      reason: PRECHECK_TIMEOUT_REASON,
      exitCode: null,
      stdout: "",
      stderr: "aborted",
    };
  }

  // Revalidate durable receipt / run currency after authz await, before spawn.
  // A precheck edit/clear during authorization must not reach host execution.
  opts?.assertRunCurrent?.();

  const timeoutMs = resolveTimeoutMs(precheck);
  const spawnFn = opts?.spawnImpl ?? spawn;
  const { shell, args: shellArgs } = resolveTrustedPrecheckShellCommand(command);

  return await new Promise<CronJobPrecheckResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Detached process group on POSIX so timeout/abort can terminate the full tree
    // (shell + background descendants), matching system-run lifecycle.
    const child = spawnFn(shell, shellArgs, {
      cwd,
      env: resolvePrecheckExecEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const terminateChildTree = () => {
      const pid = child.pid;
      if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
        try {
          killProcessTree(pid, {
            force: true,
            detached: process.platform !== "win32",
          });
        } catch {
          // fall through to direct kill
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };

    const finish = (result: CronJobPrecheckResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      opts?.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree();
      finish({
        decision: "error",
        reason: PRECHECK_TIMEOUT_REASON,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr),
      });
    }, timeoutMs);

    const onAbort = () => {
      terminateChildTree();
      finish({
        decision: "error",
        reason: PRECHECK_TIMEOUT_REASON,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr || "aborted"),
      });
    };
    opts?.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS * 2) {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_CHARS * 2) {
        stderr += chunk;
      }
    });

    child.on("error", (err) => {
      finish({
        decision: "error",
        reason: `${PRECHECK_ERROR_REASON}: ${err.message}`,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr || err.message),
      });
    });

    child.on("close", (code) => {
      if (timedOut || settled) {
        return;
      }
      const result = interpretPrecheckOutput({
        exitCode: code,
        stdout: clip(stdout),
        stderr: clip(stderr),
        contract: precheck.contract,
        workExitCodes: precheck.workExitCodes,
        noWorkExitCodes: precheck.noWorkExitCodes,
        workStdoutPrefix: precheck.workStdoutPrefix,
        noWorkStdoutPrefix: precheck.noWorkStdoutPrefix,
        onError: precheck.onError,
      });
      finish(result);
    });
  });
}

/** Map a precheck result into a CronRunOutcome (+ diagnostics) for the timer path. */
export function cronRunOutcomeFromPrecheck(
  result: CronJobPrecheckResult,
  nowMs: () => number = () => Date.now(),
): CronRunOutcome {
  if (result.decision === "run") {
    return { status: "ok" };
  }
  if (result.decision === "skip") {
    const ts = nowMs();
    const diagnostics: CronRunDiagnostics = {
      summary: result.reason,
      entries: [
        {
          ts,
          source: "cron-preflight",
          severity: "info",
          message: result.reason,
          exitCode: result.exitCode,
        },
        ...(result.stdout.trim()
          ? [
              {
                ts,
                // SAFETY: diagnostic source/severity are fixed string unions.
                source: "exec" as const,
                // SAFETY: diagnostic severity is fixed info for precheck stdout.
                severity: "info" as const,
                message: clip(result.stdout, 500),
              },
            ]
          : []),
      ],
    };
    return {
      status: "skipped",
      error: result.reason,
      summary: result.reason,
      diagnostics,
    };
  }
  return {
    status: "error",
    error: result.reason,
    diagnostics: createCronRunDiagnosticsFromError("cron-preflight", result.reason, {
      severity: "error",
      nowMs,
      exitCode: result.exitCode,
    }),
  };
}

/** Lightweight structural validation / normalization of a precheck object. */
export function normalizeCronJobPrecheck(value: unknown): CronJobPrecheck | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rec = toStringKeyRecord(value);

  const command = normalizeOptionalString(rec.command);
  if (!command) {
    return undefined;
  }
  // SAFETY: only exec kind is supported; literal const for CronJobPrecheck.kind.
  const kind = rec.kind === "exec" || rec.kind === undefined ? ("exec" as const) : undefined;
  if (!kind) {
    return undefined;
  }
  // Fail closed: present-but-invalid optional fields must throw so row decode
  // quarantines the job instead of silently coercing to defaults.
  let timeoutMs: number | undefined;
  if (rec.timeoutMs !== undefined && rec.timeoutMs !== null) {
    if (
      typeof rec.timeoutMs !== "number" ||
      !Number.isFinite(rec.timeoutMs) ||
      rec.timeoutMs <= 0
    ) {
      throw new Error("precheck.timeoutMs must be a positive finite number when set");
    }
    timeoutMs = Math.min(Math.floor(rec.timeoutMs), MAX_TIMEOUT_MS);
  }
  let contract: CronJobPrecheck["contract"] | undefined;
  if (rec.contract !== undefined && rec.contract !== null) {
    if (
      rec.contract !== "exit-code" &&
      rec.contract !== "stdout-prefix" &&
      rec.contract !== "dual"
    ) {
      throw new Error('precheck.contract must be "exit-code", "stdout-prefix", or "dual" when set');
    }
    contract = rec.contract;
  }
  let onError: CronJobPrecheck["onError"] | undefined;
  if (rec.onError !== undefined && rec.onError !== null) {
    if (rec.onError !== "fail" && rec.onError !== "skip") {
      throw new Error('precheck.onError must be "fail" or "skip" when set');
    }
    onError = rec.onError;
  }
  const toIntList = (v: unknown, field: string): number[] | undefined => {
    if (v === undefined || v === null) {
      return undefined;
    }
    if (!Array.isArray(v)) {
      throw new Error(`precheck.${field} must be an array of finite numbers when set`);
    }
    if (v.length === 0) {
      throw new Error(`precheck.${field} must be a non-empty array when set`);
    }
    const nums: number[] = [];
    for (const x of v) {
      if (typeof x !== "number" || !Number.isFinite(x)) {
        throw new Error(`precheck.${field} must contain only finite numbers`);
      }
      nums.push(Math.trunc(x));
    }
    return nums;
  };
  const workExitCodes = toIntList(rec.workExitCodes, "workExitCodes");
  const noWorkExitCodes = toIntList(rec.noWorkExitCodes, "noWorkExitCodes");
  if (workExitCodes && noWorkExitCodes) {
    const noWork = new Set(noWorkExitCodes);
    const overlap = workExitCodes.filter((code) => noWork.has(code));
    if (overlap.length > 0) {
      throw new Error(
        `precheck.workExitCodes and precheck.noWorkExitCodes must not overlap (shared: ${[...new Set(overlap)].toSorted((a, b) => a - b).join(", ")})`,
      );
    }
  }
  const cwd = normalizeOptionalString(rec.cwd);
  // Reject whitespace-only prefixes before normalizeOptionalString collapses them
  // to absent (which would silently restore default WORK_NEEDED/NO_WORK).
  if (typeof rec.workStdoutPrefix === "string" && rec.workStdoutPrefix.trim().length === 0) {
    throw new Error("precheck.workStdoutPrefix must be non-empty when set");
  }
  if (typeof rec.noWorkStdoutPrefix === "string" && rec.noWorkStdoutPrefix.trim().length === 0) {
    throw new Error("precheck.noWorkStdoutPrefix must be non-empty when set");
  }
  const workStdoutPrefix = normalizeOptionalString(rec.workStdoutPrefix);
  const noWorkStdoutPrefix = normalizeOptionalString(rec.noWorkStdoutPrefix);
  return {
    kind: "exec",
    command,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(contract ? { contract } : {}),
    ...(onError ? { onError } : {}),
    ...(workExitCodes ? { workExitCodes } : {}),
    ...(noWorkExitCodes ? { noWorkExitCodes } : {}),
    ...(cwd ? { cwd } : {}),
    ...(workStdoutPrefix ? { workStdoutPrefix } : {}),
    ...(noWorkStdoutPrefix ? { noWorkStdoutPrefix } : {}),
  };
}

function toStringKeyRecord(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry;
  }
  return out;
}
