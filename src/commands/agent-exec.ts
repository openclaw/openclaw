import fs from "node:fs";
import path from "node:path";
import { listAgentIds } from "../agents/agent-scope.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import { loadConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommand } from "./agent.js";

export type AgentExecCliOpts = {
  agent?: string;
  jobId?: string;
  jobPath?: string;
  timeout?: string;
  json?: boolean;
  forceRerun?: boolean;
};

type AgentExecEnvelope = {
  kind: "agent_exec";
  version: 1;
  agent_id: string;
  job_id: string;
  job_path: string;
  job_folder: string;
  next_action: string;
  hard_boundaries: string[];
  required_proofs: string[];
  status_writeback_path: string;
  proof_writeback_path: string;
  transcript_path: string;
  stop_conditions: ["proof_ready", "failed", "blocked_needs_corey"];
};

type AgentExecState =
  | "started"
  | "agent_working"
  | "proof_ready"
  | "completed"
  | "failed"
  | "blocked_needs_corey"
  | "timed_out"
  | "refused_terminal"
  | "refused_proof_ready"
  | "locked";

type AgentExecResult = {
  state: AgentExecState;
  agentId: string;
  jobId: string;
  jobPath: string;
  jobFolder: string;
  lockPath: string;
  readyForDomReview: boolean;
  claimedResult?: string;
  refusalReason?: string;
};

function parseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return 300;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--timeout must be a positive integer in seconds");
  }
  return parsed;
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeJobPath(jobPath: string): string {
  const resolved = path.resolve(jobPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Job path does not exist: ${resolved}`);
  }
  return resolved;
}

function ensureKnownAgent(agentRaw: string): string {
  const cfg = loadConfig();
  const agentId = normalizeAgentId(agentRaw);
  if (!listAgentIds(cfg).includes(agentId)) {
    throw new Error(
      `Unknown agent id "${agentRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
    );
  }
  return agentId;
}

function resolveEnvelope(params: {
  agentId: string;
  jobId: string;
  jobPath: string;
}): AgentExecEnvelope {
  const job = readJsonFile(params.jobPath) as Record<string, unknown>;
  const jobFolder = path.dirname(params.jobPath);
  const nextAction =
    typeof job.next_action === "string" && job.next_action.trim()
      ? job.next_action.trim()
      : "Read the job artifact, execute within boundaries, and write truthful status/proof artifacts.";
  const hardBoundaries = Array.isArray(job.hard_boundaries)
    ? job.hard_boundaries.filter((value): value is string => typeof value === "string")
    : [];
  const requiredProofs = Array.isArray(job.required_proofs)
    ? job.required_proofs.filter((value): value is string => typeof value === "string")
    : [];
  return {
    kind: "agent_exec",
    version: 1,
    agent_id: params.agentId,
    job_id: params.jobId,
    job_path: params.jobPath,
    job_folder: jobFolder,
    next_action: nextAction,
    hard_boundaries: hardBoundaries,
    required_proofs: requiredProofs,
    status_writeback_path: path.join(jobFolder, "agent-status.json"),
    proof_writeback_path: path.join(jobFolder, "agent-proof.json"),
    transcript_path: path.join(jobFolder, "transcript.md"),
    stop_conditions: ["proof_ready", "failed", "blocked_needs_corey"],
  };
}

function buildExecutionMessage(envelope: AgentExecEnvelope): string {
  return [
    "[OpenClaw agent-exec envelope]",
    JSON.stringify(envelope, null, 2),
    "",
    "Treat this as executable work intake, not normal chat.",
    `Read the job artifact at: ${envelope.job_path}`,
    `Write status to: ${envelope.status_writeback_path}`,
    `Write proof to: ${envelope.proof_writeback_path}`,
    "Stop only when proof is ready for Dom review, the job has failed, or a true Corey decision gap blocks progress.",
  ].join("\n");
}

function readProofState(jobFolder: string): { readyForDomReview: boolean; claimedResult?: string } {
  const proofPath = path.join(jobFolder, "agent-proof.json");
  if (!fs.existsSync(proofPath)) {
    return { readyForDomReview: false };
  }
  const proof = readJsonFile(proofPath) as Record<string, unknown>;
  return {
    readyForDomReview: proof.ready_for_dom_review === true,
    claimedResult: typeof proof.claimed_result === "string" ? proof.claimed_result : undefined,
  };
}

function readStatusState(jobFolder: string): string | undefined {
  const statusPath = path.join(jobFolder, "agent-status.json");
  if (!fs.existsSync(statusPath)) {
    return undefined;
  }
  const status = readJsonFile(statusPath) as Record<string, unknown>;
  return typeof status.status === "string" ? status.status : undefined;
}

function resolveFinalState(params: {
  timeoutHit: boolean;
  jobFolder: string;
}): Pick<AgentExecResult, "state" | "readyForDomReview" | "claimedResult"> {
  const proof = readProofState(params.jobFolder);
  const status = readStatusState(params.jobFolder);
  if (proof.readyForDomReview) {
    return {
      state: status === "completed" ? "completed" : "proof_ready",
      readyForDomReview: true,
      claimedResult: proof.claimedResult,
    };
  }
  if (status === "agent_working") {
    return {
      state: "agent_working",
      readyForDomReview: false,
      claimedResult: proof.claimedResult,
    };
  }
  if (status === "blocked_needs_corey") {
    return {
      state: "blocked_needs_corey",
      readyForDomReview: false,
      claimedResult: proof.claimedResult,
    };
  }
  if (status === "failed") {
    return {
      state: "failed",
      readyForDomReview: false,
      claimedResult: proof.claimedResult,
    };
  }
  return {
    state: params.timeoutHit ? "timed_out" : "started",
    readyForDomReview: false,
    claimedResult: proof.claimedResult,
  };
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "archived", "published"]);
const DEFAULT_LOCK_STALE_GRACE_SECONDS = 60;

type LockPayload = {
  agent_id: string;
  job_id: string;
  job_path: string;
  started_at: string;
  timeout_seconds: number;
  stale_after: string;
  pid: number;
};

function readOptionalJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return readJsonFile(filePath);
}

function appendDebugEvent(
  jobFolder: string,
  payload: {
    jobId: string;
    event: string;
    jobStatus?: unknown;
    proofReady?: boolean;
    forceRerun?: boolean;
    extra?: Record<string, unknown>;
  },
) {
  const debugPath = path.join(jobFolder, ".agent-exec-debug.jsonl");
  const record = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    job_id: payload.jobId,
    event: payload.event,
    job_status: payload.jobStatus,
    proof_ready: payload.proofReady,
    force_rerun: payload.forceRerun,
    ...payload.extra,
  };
  fs.appendFileSync(debugPath, `${JSON.stringify(record)}\n`);
}

function readJobState(jobPath: string): Record<string, unknown> {
  return readJsonFile(jobPath) as Record<string, unknown>;
}

function isTerminalJobStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_JOB_STATUSES.has(status.trim().toLowerCase());
}

function formatLockError(lockPath: string, payload?: LockPayload): string {
  if (!payload) {
    return `Execution lock already exists for this job: ${lockPath}`;
  }
  return `Execution lock already exists for this job: ${lockPath}\n${JSON.stringify(payload, null, 2)}`;
}

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isStaleLock(payload: LockPayload, nowMs: number): boolean {
  const staleAfterMs = parseIsoMs(payload.stale_after);
  if (staleAfterMs !== undefined) {
    return nowMs > staleAfterMs;
  }
  const startedAtMs = parseIsoMs(payload.started_at);
  if (startedAtMs === undefined) {
    return false;
  }
  const maxAgeMs = (payload.timeout_seconds + DEFAULT_LOCK_STALE_GRACE_SECONDS) * 1000;
  return nowMs - startedAtMs > maxAgeMs;
}

function readLockPayload(lockPath: string): LockPayload | undefined {
  return readOptionalJsonFile(lockPath) as LockPayload | undefined;
}

function acquireLock(lockPath: string, payload: LockPayload) {
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fs.closeSync(fd);
    return {
      lockPayload: payload,
      staleLockCleared: false,
      staleLockReason: undefined as string | undefined,
    };
  } catch (error) {
    const existing = readLockPayload(lockPath);
    const nowMs = Date.now();
    if (existing && isStaleLock(existing, nowMs)) {
      fs.rmSync(lockPath, { force: true });
      try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
        fs.closeSync(fd);
        return {
          lockPayload: payload,
          staleLockCleared: true,
          staleLockReason: `Cleared stale lock from ${existing.started_at} (stale_after=${existing.stale_after}).`,
        };
      } catch {
        const retryExisting = readLockPayload(lockPath);
        throw new Error(formatLockError(lockPath, retryExisting));
      }
    }
    throw new Error(formatLockError(lockPath, existing), { cause: error });
  }
}

export async function agentExecCommand(
  opts: AgentExecCliOpts,
  runtime: RuntimeEnv,
  deps?: CliDeps,
): Promise<AgentExecResult> {
  const agentRaw = (opts.agent ?? "").trim();
  const jobId = (opts.jobId ?? "").trim();
  const jobPathRaw = (opts.jobPath ?? "").trim();
  if (!agentRaw) {
    throw new Error("--agent is required");
  }
  if (!jobId) {
    throw new Error("--job-id is required");
  }
  if (!jobPathRaw) {
    throw new Error("--job-path is required");
  }

  const agentId = ensureKnownAgent(agentRaw);
  const jobPath = normalizeJobPath(jobPathRaw);
  const timeoutSeconds = parseTimeoutSeconds(opts.timeout);
  const jobFolder = path.dirname(jobPath);
  const lockPath = path.join(jobFolder, ".agent-exec.lock.json");
  appendDebugEvent(jobFolder, {
    jobId,
    event: "handler_entered",
    forceRerun: Boolean(opts.forceRerun),
    extra: { agent_id: agentId, raw_job_path: jobPathRaw },
  });
  appendDebugEvent(jobFolder, {
    jobId,
    event: "job_path_resolved",
    forceRerun: Boolean(opts.forceRerun),
    extra: { resolved_job_path: jobPath },
  });
  const job = readJobState(jobPath);
  appendDebugEvent(jobFolder, {
    jobId,
    event: "job_loaded",
    jobStatus: job.status,
    forceRerun: Boolean(opts.forceRerun),
  });
  const proof = readProofState(jobFolder);
  appendDebugEvent(jobFolder, {
    jobId,
    event: "proof_loaded",
    jobStatus: job.status,
    proofReady: proof.readyForDomReview,
    forceRerun: Boolean(opts.forceRerun),
  });
  const terminalRefusalSelected = !opts.forceRerun && isTerminalJobStatus(job.status);
  const proofReadyRefusalSelected = !opts.forceRerun && proof.readyForDomReview;
  appendDebugEvent(jobFolder, {
    jobId,
    event: "guard_evaluated",
    jobStatus: job.status,
    proofReady: proof.readyForDomReview,
    forceRerun: Boolean(opts.forceRerun),
    extra: {
      terminal_refusal_selected: terminalRefusalSelected,
      proof_ready_refusal_selected: proofReadyRefusalSelected,
    },
  });
  if (terminalRefusalSelected) {
    appendDebugEvent(jobFolder, {
      jobId,
      event: "terminal_refusal_selected",
      jobStatus: job.status,
      proofReady: proof.readyForDomReview,
      forceRerun: Boolean(opts.forceRerun),
    });
    const result: AgentExecResult = {
      state: "refused_terminal",
      agentId,
      jobId,
      jobPath,
      jobFolder,
      lockPath,
      readyForDomReview: proof.readyForDomReview,
      claimedResult: proof.claimedResult,
      refusalReason: `Refusing to run agent-exec for terminal job status: ${String(job.status)}`,
    };
    appendDebugEvent(jobFolder, {
      jobId,
      event: "returning_terminal_refusal",
      jobStatus: job.status,
      proofReady: proof.readyForDomReview,
      forceRerun: Boolean(opts.forceRerun),
      extra: { refusal_reason: result.refusalReason },
    });
    if (opts.json) {
      runtime.log(JSON.stringify(result, null, 2));
    } else {
      runtime.log(result.refusalReason);
    }
    return result;
  }
  if (proofReadyRefusalSelected) {
    appendDebugEvent(jobFolder, {
      jobId,
      event: "proof_ready_refusal_selected",
      jobStatus: job.status,
      proofReady: proof.readyForDomReview,
      forceRerun: Boolean(opts.forceRerun),
    });
    const result: AgentExecResult = {
      state: "refused_proof_ready",
      agentId,
      jobId,
      jobPath,
      jobFolder,
      lockPath,
      readyForDomReview: true,
      claimedResult: proof.claimedResult,
      refusalReason:
        "Refusing to run agent-exec because agent-proof.json is already ready for Dom review. Pass --force-rerun only for an intentional reset/retry flow.",
    };
    appendDebugEvent(jobFolder, {
      jobId,
      event: "returning_proof_ready_refusal",
      jobStatus: job.status,
      proofReady: proof.readyForDomReview,
      forceRerun: Boolean(opts.forceRerun),
      extra: { refusal_reason: result.refusalReason },
    });
    if (opts.json) {
      runtime.log(JSON.stringify(result, null, 2));
    } else {
      runtime.log(result.refusalReason);
    }
    return result;
  }

  const now = new Date();
  const staleAfter = new Date(
    now.getTime() + (timeoutSeconds + DEFAULT_LOCK_STALE_GRACE_SECONDS) * 1000,
  ).toISOString();
  let lockAcquired = false;
  let staleLockReason: string | undefined;
  appendDebugEvent(jobFolder, {
    jobId,
    event: "lock_acquisition_attempted",
    jobStatus: job.status,
    proofReady: proof.readyForDomReview,
    forceRerun: Boolean(opts.forceRerun),
    extra: { lock_path: lockPath, stale_after: staleAfter },
  });
  try {
    const lockResult = acquireLock(lockPath, {
      agent_id: agentId,
      job_id: jobId,
      job_path: jobPath,
      started_at: now.toISOString(),
      timeout_seconds: timeoutSeconds,
      stale_after: staleAfter,
      pid: process.pid,
    });
    lockAcquired = true;
    staleLockReason = lockResult.staleLockReason;
    appendDebugEvent(jobFolder, {
      jobId,
      event: "lock_acquired",
      jobStatus: job.status,
      proofReady: proof.readyForDomReview,
      forceRerun: Boolean(opts.forceRerun),
      extra: { stale_lock_reason: staleLockReason },
    });
  } catch (error) {
    const refusalReason = error instanceof Error ? error.message : String(error);
    appendDebugEvent(jobFolder, {
      jobId,
      event: "lock_refusal_return",
      jobStatus: job.status,
      proofReady: proof.readyForDomReview,
      forceRerun: Boolean(opts.forceRerun),
      extra: { refusal_reason: refusalReason },
    });
    const result: AgentExecResult = {
      state: "locked",
      agentId,
      jobId,
      jobPath,
      jobFolder,
      lockPath,
      readyForDomReview: proof.readyForDomReview,
      claimedResult: proof.claimedResult,
      refusalReason,
    };
    if (opts.json) {
      runtime.log(JSON.stringify(result, null, 2));
    } else {
      runtime.log(refusalReason);
    }
    return result;
  }

  const envelope = resolveEnvelope({ agentId, jobId, jobPath });

  let timeoutHit = false;
  try {
    appendDebugEvent(jobFolder, {
      jobId,
      event: "before_agent_command",
      jobStatus: job.status,
      proofReady: proof.readyForDomReview,
      forceRerun: Boolean(opts.forceRerun),
    });
    const agentOpts: AgentCommandOpts = {
      agentId,
      message: buildExecutionMessage(envelope),
      timeout: String(timeoutSeconds),
      extraSystemPrompt:
        "This run was started by openclaw agent-exec. Treat the input envelope as structured executable work intake rather than normal user chat.",
    };
    await agentCommand(agentOpts, runtime, deps);
    appendDebugEvent(jobFolder, {
      jobId,
      event: "after_agent_command",
      jobStatus: job.status,
      proofReady: proof.readyForDomReview,
      forceRerun: Boolean(opts.forceRerun),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      timeoutHit = true;
      appendDebugEvent(jobFolder, {
        jobId,
        event: "agent_command_timed_out",
        jobStatus: job.status,
        proofReady: proof.readyForDomReview,
        forceRerun: Boolean(opts.forceRerun),
        extra: { error_message: message },
      });
    } else {
      appendDebugEvent(jobFolder, {
        jobId,
        event: "agent_command_error",
        jobStatus: job.status,
        proofReady: proof.readyForDomReview,
        forceRerun: Boolean(opts.forceRerun),
        extra: { error_message: message },
      });
      throw error;
    }
  } finally {
    if (lockAcquired) {
      fs.rmSync(lockPath, { force: true });
      appendDebugEvent(jobFolder, {
        jobId,
        event: "lock_removed",
        jobStatus: job.status,
        proofReady: proof.readyForDomReview,
        forceRerun: Boolean(opts.forceRerun),
      });
    }
  }

  const finalState = resolveFinalState({ timeoutHit, jobFolder });
  const result: AgentExecResult = {
    state: finalState.state,
    agentId,
    jobId,
    jobPath,
    jobFolder,
    lockPath,
    readyForDomReview: finalState.readyForDomReview,
    claimedResult: finalState.claimedResult,
    refusalReason: staleLockReason,
  };

  appendDebugEvent(jobFolder, {
    jobId,
    event: "command_return_path",
    jobStatus: job.status,
    proofReady: result.readyForDomReview,
    forceRerun: Boolean(opts.forceRerun),
    extra: { final_state: result.state, refusal_reason: result.refusalReason },
  });
  if (opts.json) {
    runtime.log(JSON.stringify(result, null, 2));
  } else {
    runtime.log(
      `${result.state}: agent=${result.agentId} job=${result.jobId} ready_for_dom_review=${result.readyForDomReview ? "true" : "false"}`,
    );
  }
  return result;
}
