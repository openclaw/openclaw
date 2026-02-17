import { spawn } from "node:child_process";
import type { CronJob } from "./types.js";

type DirectCommandPayload = Extract<CronJob["payload"], { kind: "directCommand" }>;

export type DirectCommandRunResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
  result?: DirectCommandResultObject;
};

export type DirectCommandResultObject = {
  status: "ok" | "error" | "skipped";
  summary: string;
  captured: {
    stdout: string;
    stderr: string;
  };
};

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

function clampMaxOutputBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_OUTPUT_BYTES;
  }
  return Math.max(1, Math.floor(value));
}

function toUtf8(buffer: Buffer): string {
  return buffer.toString("utf8").trim();
}

function summarizeOutput(stdout: Buffer, stderr: Buffer): string {
  const stdoutText = toUtf8(stdout);
  const stderrText = toUtf8(stderr);
  if (stdoutText && stderrText) {
    return `${stdoutText}\n${stderrText}`;
  }
  return stdoutText || stderrText;
}

function createResultObject(params: {
  status: "ok" | "error" | "skipped";
  stdout: Buffer;
  stderr: Buffer;
}): DirectCommandResultObject {
  const stdoutText = toUtf8(params.stdout);
  const stderrText = toUtf8(params.stderr);
  return {
    status: params.status,
    summary: summarizeOutput(params.stdout, params.stderr),
    captured: {
      stdout: stdoutText,
      stderr: stderrText,
    },
  };
}

export function formatDirectCommandResult(result: DirectCommandResultObject): string {
  return JSON.stringify(result);
}

export async function runCronDirectCommand(params: {
  jobId: string;
  payload: DirectCommandPayload;
}): Promise<DirectCommandRunResult> {
  const { payload, jobId } = params;
  const command = payload.command?.trim();
  if (!command) {
    const result = {
      status: "skipped",
      summary: "directCommand requires a non-empty command",
      captured: { stdout: "", stderr: "" },
    } satisfies DirectCommandResultObject;
    return {
      status: "skipped",
      error: "directCommand requires a non-empty command",
      summary: formatDirectCommandResult(result),
      result,
    };
  }

  const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
  const maxOutputBytes = clampMaxOutputBytes(payload.maxOutputBytes);

  return await new Promise<DirectCommandRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    const child = spawn(command, args, {
      shell: false,
      cwd: payload.cwd,
      env: payload.env ? { ...process.env, ...payload.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutMs =
      typeof payload.timeoutSeconds === "number" && payload.timeoutSeconds > 0
        ? Math.floor(payload.timeoutSeconds * 1000)
        : undefined;

    const killTimer =
      typeof timeoutMs === "number"
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              if (!settled) {
                child.kill("SIGKILL");
              }
            }, 1_000).unref();
          }, timeoutMs)
        : undefined;

    const finish = (result: DirectCommandRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };

    child.on("error", (err) => {
      finish({ status: "error", error: `failed to start command: ${String(err)}` });
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdout = Buffer.concat([stdout, data]).subarray(0, maxOutputBytes);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = Buffer.concat([stderr, data]).subarray(0, maxOutputBytes);
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        const result = createResultObject({
          status: "error",
          stdout,
          stderr,
        });
        finish({
          status: "error",
          error: `directCommand timed out after ${timeoutMs}ms`,
          summary: formatDirectCommandResult(result),
          result,
        });
        return;
      }

      const status = code === 0 ? "ok" : "error";
      const result = createResultObject({ status, stdout, stderr });
      if (code === 0) {
        finish({ status: "ok", summary: formatDirectCommandResult(result), result });
        return;
      }

      const exitReason =
        typeof code === "number"
          ? `command exited with code ${code}`
          : `command exited with signal ${signal ?? "unknown"}`;
      finish({
        status: "error",
        error: `${exitReason} (job: ${jobId})`,
        summary: formatDirectCommandResult(result),
        result,
      });
    });
  });
}
