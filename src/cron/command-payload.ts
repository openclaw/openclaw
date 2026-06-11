import { spawn } from "node:child_process";
import { redactSensitiveText } from "../logging/redact.js";
import {
  createCronRunDiagnosticsFromError,
  normalizeCronRunDiagnostics,
} from "./run-diagnostics.js";
import type { CronServiceState } from "./service/state.js";
import type { CronJob, CronRunOutcome, CronRunTelemetry } from "./types.js";

const DEFAULT_OUTPUT_LIMIT_BYTES = 16_000;

type CommandPayload = Extract<CronJob["payload"], { kind: "command" }>;

type CommandExecutionResult = CronRunOutcome &
  CronRunTelemetry & {
    delivered?: boolean;
    deliveryAttempted?: boolean;
  };

function normalizeOutputLimit(payload: CommandPayload): number {
  if (typeof payload.outputLimitBytes !== "number" || !Number.isFinite(payload.outputLimitBytes)) {
    return DEFAULT_OUTPUT_LIMIT_BYTES;
  }
  return Math.max(0, Math.floor(payload.outputLimitBytes));
}

function tailByBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { text: "", truncated: value.length > 0 };
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }
  let start = Math.max(0, value.length - maxBytes);
  while (start < value.length && Buffer.byteLength(value.slice(start), "utf8") > maxBytes) {
    start += 1;
  }
  return { text: value.slice(start), truncated: true };
}

function appendLimitedTail(
  current: string,
  chunk: Buffer,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const next = `${current}${chunk.toString("utf8")}`;
  return tailByBytes(next, maxBytes);
}

function shellQuoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function formatCommandLine(payload: CommandPayload): string {
  return [payload.command, ...(payload.args ?? [])].map(shellQuoteForDisplay).join(" ");
}

function buildCommandSummary(params: {
  payload: CommandPayload;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}): string {
  const status =
    typeof params.exitCode === "number"
      ? `exit ${params.exitCode}`
      : params.signal
        ? `signal ${params.signal}`
        : "unknown exit";
  const parts = [`Command ${formatCommandLine(params.payload)} finished with ${status}.`];
  if (params.stdout.trim()) {
    parts.push(`stdout:\n${params.stdout.trimEnd()}`);
  }
  if (params.stderr.trim()) {
    parts.push(`stderr:\n${params.stderr.trimEnd()}`);
  }
  if (params.truncated) {
    parts.push("Output was truncated to the configured tail limit.");
  }
  return redactSensitiveText(parts.join("\n\n"), { mode: "tools" });
}

function successExitCodes(payload: CommandPayload): Set<number> {
  const raw = payload.successExitCodes?.length ? payload.successExitCodes : [0];
  return new Set(raw.map((value) => Math.floor(value)));
}

export async function executeCommandPayloadCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal?: AbortSignal,
): Promise<CommandExecutionResult> {
  if (job.payload.kind !== "command") {
    const error = 'command cron executor requires payload.kind="command"';
    return {
      status: "skipped",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
        severity: "warn",
        nowMs: state.deps.nowMs,
      }),
    };
  }

  const payload = job.payload;
  const outputLimit = normalizeOutputLimit(payload);
  const commandLine = formatCommandLine(payload);
  state.deps.log.info(
    { jobId: job.id, command: payload.command, args: payload.args?.length ?? 0 },
    "cron: running command payload",
  );

  return await new Promise<CommandExecutionResult>((resolve) => {
    if (abortSignal?.aborted) {
      const error = "cron: job execution timed out";
      resolve({
        status: "error",
        error,
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
          nowMs: state.deps.nowMs,
        }),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const settle = (result: CommandExecutionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(payload.command, payload.args ?? [], {
        cwd: payload.cwd,
        env: payload.env ? { ...process.env, ...payload.env } : process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        signal: abortSignal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle({
        status: "error",
        error: message,
        summary: `Command ${commandLine} failed to start: ${message}`,
        diagnostics: createCronRunDiagnosticsFromError("exec", message, {
          nowMs: state.deps.nowMs,
          toolName: "cron.command",
        }),
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendLimitedTail(stdout, chunk, outputLimit);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendLimitedTail(stderr, chunk, outputLimit);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });
    child.on("error", (error: Error) => {
      const message = error.name === "AbortError" ? "cron: job execution timed out" : error.message;
      settle({
        status: "error",
        error: message,
        summary: `Command ${commandLine} failed: ${message}`,
        diagnostics: createCronRunDiagnosticsFromError("exec", message, {
          nowMs: state.deps.nowMs,
          toolName: "cron.command",
        }),
      });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (abortSignal?.aborted) {
        const error = "cron: job execution timed out";
        settle({
          status: "error",
          error,
          diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
            nowMs: state.deps.nowMs,
          }),
        });
        return;
      }
      const ok = typeof code === "number" && successExitCodes(payload).has(code);
      const summary = buildCommandSummary({
        payload,
        exitCode: code,
        signal,
        stdout,
        stderr,
        truncated: stdoutTruncated || stderrTruncated,
      });
      settle({
        status: ok ? "ok" : "error",
        ...(ok ? {} : { error: `command exited with ${code ?? signal ?? "unknown status"}` }),
        summary,
        diagnostics: normalizeCronRunDiagnostics(
          {
            summary,
            entries: [
              {
                ts: state.deps.nowMs(),
                source: "exec",
                severity: ok ? "info" : "error",
                message: summary,
                toolName: "cron.command",
                exitCode: code,
                truncated: stdoutTruncated || stderrTruncated,
              },
            ],
          },
          { nowMs: state.deps.nowMs },
        ),
      });
    });
  });
}
