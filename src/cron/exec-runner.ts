import { spawn } from "node:child_process";
import type { CronExecPayload, CronRunOutcome } from "./types.js";

const DEFAULT_ABORT_ERROR = "cron: job execution timed out";
const MAX_CAPTURE_CHARS = 128 * 1024;

type ParsedCommand = {
  command: string;
  args: string[];
};

function trimCapturedOutput(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function appendChunk(state: { text: string; truncated: boolean }, chunk: string) {
  if (!chunk || state.truncated) {
    return;
  }
  const remaining = MAX_CAPTURE_CHARS - state.text.length;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (chunk.length <= remaining) {
    state.text += chunk;
    return;
  }
  state.text += chunk.slice(0, remaining);
  state.truncated = true;
}

function formatCapturedOutput(label: "stdout" | "stderr", value: string, truncated: boolean) {
  const trimmed = trimCapturedOutput(value);
  if (!trimmed) {
    return undefined;
  }
  const suffix = truncated ? "\n[truncated]" : "";
  return `${label}:\n${trimmed}${suffix}`;
}

function formatCommandSummary(params: {
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut?: boolean;
  timeoutMs?: number;
  spawnError?: string;
}) {
  const header = params.spawnError
    ? `Command failed to start: ${params.spawnError}`
    : params.timedOut
      ? `Command timed out after ${params.timeoutMs ?? 0}ms.`
      : typeof params.exitCode === "number"
        ? `Command exited with code ${params.exitCode}.`
        : params.signal
          ? `Command terminated by signal ${params.signal}.`
          : "Command finished.";

  const sections = [
    header,
    formatCapturedOutput("stdout", params.stdout, params.stdoutTruncated),
    formatCapturedOutput("stderr", params.stderr, params.stderrTruncated),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return sections.join("\n\n");
}

function parseExecCommand(command: string): ParsedCommand {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('cron exec payload requires a non-empty "command"');
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of trimmed) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      if (quote === "'") {
        current += char;
      } else {
        escaping = true;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error(`cron exec command has an unterminated ${quote} quote`);
  }
  if (current) {
    tokens.push(current);
  }
  const [resolvedCommand, ...args] = tokens;
  if (!resolvedCommand) {
    throw new Error('cron exec payload requires a non-empty "command"');
  }
  return { command: resolvedCommand, args };
}

export async function runCronExec(params: {
  payload: CronExecPayload;
  abortSignal?: AbortSignal;
}): Promise<CronRunOutcome> {
  const timeoutMs =
    typeof params.payload.timeout === "number" && Number.isFinite(params.payload.timeout)
      ? Math.max(0, Math.floor(params.payload.timeout))
      : 0;

  const useShell = params.payload.shell === true;

  let parsed: ParsedCommand | undefined;
  if (!useShell) {
    try {
      parsed = parseExecCommand(params.payload.command);
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  const stdoutState = { text: "", truncated: false };
  const stderrState = { text: "", truncated: false };

  return await new Promise<CronRunOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;

    const child = spawn(
      useShell ? params.payload.command : parsed!.command,
      useShell ? [] : parsed!.args,
      {
        shell: useShell,
        stdio: ["ignore", "pipe", "pipe"],
        detached: useShell && process.platform !== "win32",
      },
    );

    const settle = (result: CronRunOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const killChild = () => {
      if (child.killed) {
        return;
      }
      if (useShell && process.platform !== "win32" && child.pid != null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    };

    const onAbort = () => {
      killChild();
    };

    const timeoutId =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killChild();
          }, timeoutMs)
        : undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      params.abortSignal?.removeEventListener("abort", onAbort);
    };

    params.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: string | Buffer) => {
      appendChunk(stdoutState, chunk.toString());
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      appendChunk(stderrState, chunk.toString());
    });

    child.on("error", (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      settle({
        status: "error",
        error: errorMessage,
        summary: formatCommandSummary({
          spawnError: errorMessage,
          stdout: stdoutState.text,
          stderr: stderrState.text,
          stdoutTruncated: stdoutState.truncated,
          stderrTruncated: stderrState.truncated,
        }),
      });
    });

    child.on("close", (code, signal) => {
      const summary = formatCommandSummary({
        exitCode: code ?? undefined,
        signal,
        stdout: stdoutState.text,
        stderr: stderrState.text,
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated,
        timedOut,
        timeoutMs: timeoutId ? timeoutMs : undefined,
      });

      if (timedOut) {
        settle({
          status: "error",
          error: `cron exec command timed out after ${timeoutMs}ms`,
          summary,
        });
        return;
      }

      if (params.abortSignal?.aborted) {
        const reason = params.abortSignal.reason;
        settle({
          status: "error",
          error:
            typeof reason === "string" && reason.trim().length > 0
              ? reason.trim()
              : DEFAULT_ABORT_ERROR,
          summary,
        });
        return;
      }

      if (typeof code === "number" && code !== 0) {
        settle({
          status: "error",
          error: `cron exec command exited with code ${code}`,
          summary,
        });
        return;
      }

      if (signal) {
        settle({
          status: "error",
          error: `cron exec command terminated by signal ${signal}`,
          summary,
        });
        return;
      }

      settle({ status: "ok", summary });
    });
  });
}
