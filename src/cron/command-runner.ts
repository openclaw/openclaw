import { spawn } from "node:child_process";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCronDeliveryPlan, type CronDeliveryPlan } from "./delivery-plan.js";
import { createCronRunDiagnosticsFromError } from "./run-diagnostics.js";
import type { CronDeliveryTrace, CronJob, CronRunOutcome } from "./types.js";

const MAX_CAPTURE_CHARS = 64_000;
const HEARTBEAT_OK = "HEARTBEAT_OK";

type CommandProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

type CronCommandJob = CronJob & { payload: Extract<CronJob["payload"], { kind: "command" }> };

type CronCommandMapping = {
  status: "ok" | "error";
  summary?: string;
  notificationText?: string;
  error?: string;
};

export type CronCommandDeliveryCallback = (params: {
  message: string;
  plan: CronDeliveryPlan;
}) => Promise<void>;

function appendCaptured(
  current: string,
  chunk: Buffer | string,
): { value: string; truncated: boolean } {
  if (current.length >= MAX_CAPTURE_CHARS) {
    return { value: current, truncated: true };
  }
  const nextChunk = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  const room = MAX_CAPTURE_CHARS - current.length;
  if (nextChunk.length > room) {
    return { value: current + nextChunk.slice(0, room), truncated: true };
  }
  return { value: current + nextChunk, truncated: false };
}

function firstTrimmedString(...values: unknown[]) {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isQuietText(text: string | undefined) {
  return !text || text.trim() === HEARTBEAT_OK;
}

function formatCommandForError(job: CronJob) {
  if (job.payload.kind !== "command") {
    return "command";
  }
  const args = job.payload.args?.length ? ` ${job.payload.args.join(" ")}` : "";
  return `${job.payload.command}${args}`;
}

function formatProcessFailure(params: { job: CronJob; result: CommandProcessResult }): string {
  const command = formatCommandForError(params.job);
  const stderr = normalizeOptionalString(params.result.stderr);
  const stdout = normalizeOptionalString(params.result.stdout);
  const output = firstTrimmedString(stderr, stdout);
  const truncated =
    params.result.stderrTruncated || params.result.stdoutTruncated ? " (output truncated)" : "";
  const suffix = output ? `${truncated}: ${output.slice(0, 500)}` : truncated;
  if (params.result.exitCode !== null) {
    return `cron command failed (${command}) with exit code ${params.result.exitCode}${suffix}`;
  }
  return `cron command failed (${command}) with signal ${params.result.signal ?? "unknown"}${suffix}`;
}

async function runCommandProcess(job: CronCommandJob, abortSignal?: AbortSignal) {
  return await new Promise<CommandProcessResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const child = spawn(job.payload.command, job.payload.args ?? [], {
      cwd: job.payload.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: abortSignal,
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const captured = appendCaptured(stdout, chunk);
      stdout = captured.value;
      stdoutTruncated ||= captured.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const captured = appendCaptured(stderr, chunk);
      stderr = captured.value;
      stderrTruncated ||= captured.truncated;
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      resolve({ stdout, stderr, exitCode, signal, stdoutTruncated, stderrTruncated });
    });
  });
}

export function mapCronCommandOutput(params: {
  stdout: string;
  outputMode?: "text" | "json";
}): CronCommandMapping {
  const stdout = params.stdout.trim();
  if ((params.outputMode ?? "text") !== "json") {
    if (isQuietText(stdout)) {
      return { status: "ok" };
    }
    return { status: "ok", summary: stdout, notificationText: stdout };
  }

  if (!stdout) {
    return { status: "error", error: "cron command produced no JSON output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      status: "error",
      error: `cron command produced invalid JSON: ${formatErrorMessage(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return { status: "error", error: "cron command JSON output must be an object" };
  }

  const urgent = normalizeStringArray(parsed.urgent);
  const urgentText = urgent.length > 0 ? urgent.join("\n\n") : undefined;
  const text = firstTrimmedString(parsed.text, parsed.message);
  const summary = firstTrimmedString(parsed.summary);
  const errorText = firstTrimmedString(parsed.error);
  const ok = parsed.ok !== false;
  const notify = parsed.notify === true ? true : parsed.notify === false ? false : undefined;
  const notificationText =
    notify === false
      ? undefined
      : firstTrimmedString(urgentText, text, notify === true ? summary : undefined);

  if (!ok) {
    const error =
      firstTrimmedString(errorText, summary, notificationText) ?? "cron command returned ok=false";
    return {
      status: "error",
      error,
      summary: notificationText ?? summary ?? error,
      notificationText: notificationText ?? error,
    };
  }

  if (isQuietText(notificationText)) {
    return { status: "ok", summary };
  }
  return {
    status: "ok",
    summary: notificationText ?? summary,
    notificationText,
  };
}

function deliveryTrace(
  plan: CronDeliveryPlan,
  delivered: boolean,
  error?: string,
): CronDeliveryTrace {
  return {
    intended: {
      channel: plan.channel,
      to: plan.to,
      accountId: plan.accountId,
      threadId: plan.threadId,
      source: "explicit",
    },
    fallbackUsed: false,
    delivered,
    ...(error ? { resolved: { channel: plan.channel, to: plan.to, ok: false, error } } : {}),
  };
}

export async function runCronCommandPayload(params: {
  job: CronJob;
  abortSignal?: AbortSignal;
  nowMs?: () => number;
  deliverAnnouncement?: CronCommandDeliveryCallback;
}): Promise<
  CronRunOutcome & {
    delivered?: boolean;
    deliveryAttempted?: boolean;
    delivery?: CronDeliveryTrace;
  }
> {
  if (params.job.payload.kind !== "command") {
    return { status: "skipped", error: 'cron command runner requires payload.kind="command"' };
  }

  let processResult: CommandProcessResult;
  try {
    processResult = await runCommandProcess(params.job as CronCommandJob, params.abortSignal);
  } catch (error) {
    const message = formatErrorMessage(error);
    return {
      status: "error",
      error: message,
      diagnostics: createCronRunDiagnosticsFromError("exec", message, {
        nowMs: params.nowMs,
        toolName: params.job.payload.command,
      }),
    };
  }

  if (params.abortSignal?.aborted) {
    const message = "cron command aborted";
    return {
      status: "error",
      error: message,
      diagnostics: createCronRunDiagnosticsFromError("exec", message, {
        nowMs: params.nowMs,
        toolName: params.job.payload.command,
      }),
    };
  }

  if (processResult.exitCode !== 0) {
    const message = formatProcessFailure({ job: params.job, result: processResult });
    return {
      status: "error",
      error: message,
      diagnostics: createCronRunDiagnosticsFromError("exec", message, {
        nowMs: params.nowMs,
        toolName: params.job.payload.command,
        exitCode: processResult.exitCode,
      }),
    };
  }

  const mapped = mapCronCommandOutput({
    stdout: processResult.stdout,
    outputMode: params.job.payload.output,
  });
  if (mapped.status === "error") {
    return {
      status: "error",
      error: mapped.error,
      summary: mapped.summary,
      diagnostics: createCronRunDiagnosticsFromError("exec", mapped.error, {
        nowMs: params.nowMs,
        toolName: params.job.payload.command,
      }),
    };
  }

  const plan = resolveCronDeliveryPlan(params.job);
  if (!mapped.notificationText || plan.mode !== "announce" || !plan.requested) {
    return {
      status: "ok",
      summary: mapped.summary,
      delivered: plan.requested ? undefined : false,
      deliveryAttempted: false,
    };
  }

  if (!params.deliverAnnouncement) {
    const message = "cron command announce delivery is unavailable";
    return {
      status: "error",
      error: message,
      summary: mapped.summary,
      delivered: false,
      deliveryAttempted: true,
      delivery: deliveryTrace(plan, false, message),
      diagnostics: createCronRunDiagnosticsFromError("delivery", message, {
        nowMs: params.nowMs,
      }),
    };
  }

  try {
    await params.deliverAnnouncement({ message: mapped.notificationText, plan });
    return {
      status: "ok",
      summary: mapped.summary,
      delivered: true,
      deliveryAttempted: true,
      delivery: deliveryTrace(plan, true),
    };
  } catch (error) {
    const message = `cron command delivery failed: ${formatErrorMessage(error)}`;
    if (params.job.delivery?.bestEffort === true) {
      return {
        status: "ok",
        summary: mapped.summary,
        delivered: false,
        deliveryAttempted: true,
        delivery: deliveryTrace(plan, false, message),
      };
    }
    return {
      status: "error",
      error: message,
      summary: mapped.summary,
      delivered: false,
      deliveryAttempted: true,
      delivery: deliveryTrace(plan, false, message),
      diagnostics: createCronRunDiagnosticsFromError("delivery", message, {
        nowMs: params.nowMs,
      }),
    };
  }
}
