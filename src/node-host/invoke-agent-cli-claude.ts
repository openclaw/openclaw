/** Validates and streams one approval-gated Claude CLI turn on a headless node. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import { resolveSafeChildProcessInvocation } from "../process/windows-command.js";
import { signalProcessTree } from "../process/kill-tree.js";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import type { NodeHostClient } from "./client.js";
import type { RunResult } from "./invoke-types.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

const MAX_ARG_COUNT = 128;
const MAX_ARG_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_CAP_BYTES = 200_000;
const STDERR_TAIL_BYTES = 20_000;
const PROGRESS_CHUNK_BYTES = 16 * 1024;
const TERMINAL_EVENT_MAX_BYTES = 1024 * 1024;
const MIN_HEARTBEAT_INTERVAL_MS = 250;
const MAX_HEARTBEAT_INTERVAL_MS = 5_000;

// Mirror the Claude flags produced by extensions/anthropic/cli-shared.ts and
// cli-backend.ts. Node execution intentionally excludes file/plugin/MCP/tool
// flags so gateway-local paths can never escape onto the remote host.
const BARE_ARGS = new Set([
  "-p",
  "--print",
  "--include-partial-messages",
  "--verbose",
  "--fork-session",
  "--safe-mode",
  "--bare",
  "--no-chrome",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--exclude-dynamic-system-prompt-sections",
  "--include-hook-events",
  "--replay-user-messages",
]);

const VALUE_ARGS = new Set([
  "--output-format",
  "--input-format",
  "--setting-sources",
  "--permission-mode",
  "--resume",
  "-r",
  "--session-id",
  "--model",
  "--effort",
  "--max-turns",
  "--fallback-model",
  "--prompt-suggestions",
  "--max-budget-usd",
]);

const ENV_ALLOWLIST = new Set(["FORCE_COLOR", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "TERM"]);

export type ClaudeCliNodeRunParams = {
  argv: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  systemPrompt?: string;
  agentId?: string;
  sessionKey?: string;
  approvalDecision?: "allow-once" | "allow-always";
  systemRunPlan?: SystemRunApprovalPlan;
  idleTimeoutMs: number;
  timeoutMs: number;
};

export type ClaudeCliNodeRunResult = {
  exitCode: number;
  stderrTail: string;
  truncated: boolean;
  timeoutKind?: "hard" | "idle";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeJson(raw?: string | null): unknown {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`INVALID_REQUEST: ${label} must be a bounded string`);
  }
  return value;
}

function validateArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARG_COUNT) {
    throw new Error("INVALID_REQUEST: argv must be a bounded non-empty array");
  }
  const args = value.map((entry, index) =>
    requireBoundedString(entry, `argv[${index}]`, MAX_ARG_BYTES),
  );
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    if (BARE_ARGS.has(arg)) {
      continue;
    }
    if (!VALUE_ARGS.has(name)) {
      throw new Error(`INVALID_REQUEST: unsupported Claude CLI argument: ${arg || "<empty>"}`);
    }
    if (equalsIndex > 0) {
      const inlineValue = arg.slice(equalsIndex + 1);
      if (!inlineValue || inlineValue.startsWith("-")) {
        throw new Error(
          `INVALID_REQUEST: Claude CLI argument requires a non-option value: ${name}`,
        );
      }
      if (name === "--permission-mode" && inlineValue === "bypassPermissions") {
        throw new Error("INVALID_REQUEST: bypassPermissions is not allowed for node agent runs");
      }
      continue;
    }
    if (index + 1 >= args.length) {
      throw new Error(`INVALID_REQUEST: Claude CLI argument requires a value: ${name}`);
    }
    if (args[index + 1]?.startsWith("-")) {
      throw new Error(`INVALID_REQUEST: Claude CLI argument requires a non-option value: ${name}`);
    }
    if (name === "--permission-mode" && args[index + 1] === "bypassPermissions") {
      throw new Error("INVALID_REQUEST: bypassPermissions is not allowed for node agent runs");
    }
    index += 1;
  }
  return args;
}

function validateTimeout(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`INVALID_REQUEST: ${label} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

/** Decode the narrow, binary-free request accepted by the Claude node command. */
export async function decodeClaudeCliNodeRunParams(
  raw?: string | null,
): Promise<ClaudeCliNodeRunParams> {
  if (Buffer.byteLength(raw ?? "", "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("INVALID_REQUEST: Claude CLI request is too large");
  }
  const value = asRecord(decodeJson(raw));
  if (!value) {
    throw new Error("INVALID_REQUEST: Claude CLI params must be an object");
  }
  const allowed = new Set([
    "argv",
    "stdin",
    "cwd",
    "env",
    "systemPrompt",
    "agentId",
    "sessionKey",
    "approvalDecision",
    "systemRunPlan",
    "idleTimeoutMs",
    "timeoutMs",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`INVALID_REQUEST: unknown Claude CLI parameter: ${unknown}`);
  }
  const argv = validateArgs(value.argv);
  const stdin =
    value.stdin === undefined
      ? undefined
      : requireBoundedString(value.stdin, "stdin", MAX_REQUEST_BYTES);
  const systemPrompt =
    value.systemPrompt === undefined
      ? undefined
      : requireBoundedString(value.systemPrompt, "systemPrompt", MAX_REQUEST_BYTES);
  const agentId =
    value.agentId === undefined
      ? undefined
      : requireBoundedString(value.agentId, "agentId", MAX_ARG_BYTES);
  const sessionKey =
    value.sessionKey === undefined
      ? undefined
      : requireBoundedString(value.sessionKey, "sessionKey", MAX_ARG_BYTES);
  const approvalDecision =
    value.approvalDecision === "allow-once" || value.approvalDecision === "allow-always"
      ? value.approvalDecision
      : undefined;
  if (value.approvalDecision !== undefined && !approvalDecision) {
    throw new Error("INVALID_REQUEST: approvalDecision is invalid");
  }
  const systemRunPlan =
    value.systemRunPlan === undefined ? undefined : asRecord(value.systemRunPlan);
  if (value.systemRunPlan !== undefined && !systemRunPlan) {
    throw new Error("INVALID_REQUEST: systemRunPlan must be an object");
  }
  const cwd =
    value.cwd === undefined ? undefined : requireBoundedString(value.cwd, "cwd", MAX_ARG_BYTES);
  if (cwd) {
    const stat = await fs.stat(cwd).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error("INVALID_REQUEST: cwd must be an existing directory on the node");
    }
  }
  let env: Record<string, string> | undefined;
  if (value.env !== undefined) {
    const envValue = asRecord(value.env);
    if (!envValue) {
      throw new Error("INVALID_REQUEST: env must be an object");
    }
    env = {};
    for (const [key, candidate] of Object.entries(envValue)) {
      if (!ENV_ALLOWLIST.has(key)) {
        throw new Error(`INVALID_REQUEST: environment key is not allowed: ${key}`);
      }
      env[key] = requireBoundedString(candidate, `env.${key}`, MAX_ARG_BYTES);
    }
  }
  return {
    argv,
    ...(stdin !== undefined ? { stdin } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(approvalDecision ? { approvalDecision } : {}),
    ...(systemRunPlan ? { systemRunPlan: systemRunPlan as SystemRunApprovalPlan } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    idleTimeoutMs: validateTimeout(
      value.idleTimeoutMs,
      "idleTimeoutMs",
      MIN_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS,
    ),
    timeoutMs: validateTimeout(value.timeoutMs, "timeoutMs", 1, MAX_TIMEOUT_MS),
  };
}

async function sendProgressChunks(
  client: NodeHostClient,
  frame: NodeInvokeRequestPayload,
  startSeq: number,
  text: string,
): Promise<number> {
  let seq = startSeq;
  let remaining = text;
  while (remaining) {
    const chunk = truncateUtf8Prefix(remaining, PROGRESS_CHUNK_BYTES);
    if (!chunk) {
      break;
    }
    await client.request("node.invoke.progress", {
      invokeId: frame.id,
      nodeId: frame.nodeId,
      seq,
      chunk,
    });
    seq += 1;
    remaining = remaining.slice(chunk.length);
  }
  return seq;
}

function isClaudeResultLine(line: string): boolean {
  try {
    const value = JSON.parse(line) as { type?: unknown };
    return value?.type === "result";
  } catch {
    return false;
  }
}

/** Spawn the node-resolved Claude binary and stream bounded UTF-8 stdout. */
export async function runClaudeCliNodeCommand(params: {
  client: NodeHostClient;
  frame: NodeInvokeRequestPayload;
  request: ClaudeCliNodeRunParams;
  argv: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  timeoutMs: number | undefined;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const cancelledResult = (): RunResult => ({
    exitCode: 130,
    timedOut: false,
    success: false,
    stdout: "",
    stderr: "Claude CLI invocation cancelled",
    error: null,
    truncated: false,
  });
  if (params.signal?.aborted) {
    return cancelledResult();
  }
  let promptDir: string | undefined;
  let argv = params.argv;
  try {
    if (params.request.systemPrompt !== undefined) {
      promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-prompt-"));
      const promptPath = path.join(promptDir, "system-prompt.md");
      await fs.writeFile(promptPath, params.request.systemPrompt, { mode: 0o600 });
      argv = [...argv, "--append-system-prompt-file", promptPath];
    }
    if (params.signal?.aborted) {
      return cancelledResult();
    }
    return await new Promise<RunResult>((resolve) => {
      let settled = false;
      let hardTimedOut = false;
      let idleTimedOut = false;
      let cancelled = false;
      let truncated = false;
      let outputBytes = 0;
      let stderr = "";
      let progressSeq = 0;
      let progressQueue = Promise.resolve();
      let progressError: Error | undefined;
      let heartbeatQueued = false;
      let heartbeatDirty = false;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let lastProgressAt = 0;
      const decoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const terminalDecoder = new StringDecoder("utf8");
      let terminalLineBuffer = "";
      let terminalLineTouchesTruncation = false;
      let terminalResultLine: string | undefined;
      const invocation = resolveSafeChildProcessInvocation({
        argv,
        cwd: params.cwd,
        env: params.env ?? process.env,
      });
      const child = spawn(invocation.command, invocation.args, {
        cwd: params.cwd,
        env: params.env,
        stdio: ["pipe", "pipe", "pipe"],
        ...(process.platform !== "win32" ? { detached: true } : {}),
        windowsHide: invocation.windowsHide,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

      const kill = () => {
        const pid = child.pid;
        if (typeof pid === "number" && pid > 0) {
          signalProcessTree(pid, "SIGKILL", { detached: process.platform !== "win32" });
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort; close/error settles the result.
        }
      };
      const abortRun = () => {
        cancelled = true;
        kill();
      };
      params.signal?.addEventListener("abort", abortRun, { once: true });
      if (params.signal?.aborted) {
        abortRun();
      }
      const hardTimer = setTimeout(() => {
        hardTimedOut = true;
        kill();
      }, params.timeoutMs ?? params.request.timeoutMs);
      let idleTimer: ReturnType<typeof setTimeout>;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          kill();
        }, params.request.idleTimeoutMs);
      };
      resetIdleTimer();

      const retain = (chunk: Buffer): Buffer => {
        if (outputBytes >= OUTPUT_CAP_BYTES) {
          truncated = true;
          return Buffer.alloc(0);
        }
        const remaining = OUTPUT_CAP_BYTES - outputBytes;
        const retained = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        outputBytes += retained.length;
        if (retained.length !== chunk.length) {
          truncated = true;
        }
        return retained;
      };

      const captureTerminalLines = (raw: Buffer, touchesTruncation: boolean) => {
        terminalLineBuffer += terminalDecoder.write(raw);
        terminalLineTouchesTruncation ||= touchesTruncation;
        while (true) {
          const newline = terminalLineBuffer.indexOf("\n");
          if (newline < 0) {
            break;
          }
          const line = terminalLineBuffer.slice(0, newline).replace(/\r$/u, "");
          terminalLineBuffer = terminalLineBuffer.slice(newline + 1);
          if (
            terminalLineTouchesTruncation &&
            Buffer.byteLength(line, "utf8") <= TERMINAL_EVENT_MAX_BYTES &&
            isClaudeResultLine(line)
          ) {
            terminalResultLine = line;
          }
          terminalLineTouchesTruncation = touchesTruncation;
        }
        if (Buffer.byteLength(terminalLineBuffer, "utf8") > TERMINAL_EVENT_MAX_BYTES) {
          terminalLineBuffer = "";
          terminalLineTouchesTruncation = false;
        }
      };
      const queueProgressTask = (stream: typeof child.stdout, task: () => Promise<void>): void => {
        stream.pause();
        progressQueue = progressQueue
          .then(task)
          .catch((error: unknown) => {
            progressError = error instanceof Error ? error : new Error(String(error));
            kill();
          })
          .finally(() => stream.resume());
      };
      const heartbeatIntervalMs = Math.max(
        MIN_HEARTBEAT_INTERVAL_MS,
        Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.floor(params.request.idleTimeoutMs / 2)),
      );
      const queueHeartbeat = () => {
        if (settled) {
          return;
        }
        if (heartbeatQueued) {
          heartbeatDirty = true;
          return;
        }
        heartbeatQueued = true;
        const delayMs = Math.max(0, heartbeatIntervalMs - (Date.now() - lastProgressAt));
        heartbeatTimer = setTimeout(() => {
          heartbeatTimer = undefined;
          progressQueue = progressQueue
            .then(async () => {
              await params.client.request("node.invoke.progress", {
                invokeId: params.frame.id,
                nodeId: params.frame.nodeId,
                seq: progressSeq,
                chunk: "",
              });
              progressSeq += 1;
              lastProgressAt = Date.now();
            })
            .catch((error: unknown) => {
              progressError = error instanceof Error ? error : new Error(String(error));
              kill();
            })
            .finally(() => {
              heartbeatQueued = false;
              if (heartbeatDirty && !settled) {
                heartbeatDirty = false;
                queueHeartbeat();
              }
            });
        }, delayMs);
      };

      child.stdout.on("data", (raw: Buffer) => {
        const retained = retain(raw);
        if (retained.length > 0) {
          captureTerminalLines(retained, false);
        }
        if (retained.length < raw.length) {
          captureTerminalLines(raw.subarray(retained.length), true);
        }
        // The Gateway's inactivity timer observes stdout progress events only;
        // keep the node-local kill timer on the same signal to avoid orphan runs.
        resetIdleTimer();
        if (retained.length === 0) {
          queueHeartbeat();
          return;
        }
        const text = decoder.write(retained);
        lastProgressAt = Date.now();
        queueProgressTask(child.stdout, async () => {
          progressSeq = await sendProgressChunks(params.client, params.frame, progressSeq, text);
        });
      });
      child.stderr.on("data", (raw: Buffer) => {
        retain(raw);
        stderr = truncateUtf8Suffix(`${stderr}${stderrDecoder.write(raw)}`, STDERR_TAIL_BYTES);
        resetIdleTimer();
        queueHeartbeat();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(params.request.stdin ?? "");

      const finish = async (exitCode: number | null, error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(idleTimer);
        clearTimeout(heartbeatTimer);
        heartbeatDirty = false;
        params.signal?.removeEventListener("abort", abortRun);
        const finalText = decoder.end();
        if (finalText) {
          progressQueue = progressQueue.then(async () => {
            progressSeq = await sendProgressChunks(
              params.client,
              params.frame,
              progressSeq,
              finalText,
            );
          });
        }
        const terminalText = terminalDecoder.end();
        if (terminalText) {
          terminalLineBuffer += terminalText;
        }
        const finalStderr = stderrDecoder.end();
        if (finalStderr) {
          stderr = truncateUtf8Suffix(`${stderr}${finalStderr}`, STDERR_TAIL_BYTES);
        }
        if (
          terminalLineTouchesTruncation &&
          Buffer.byteLength(terminalLineBuffer, "utf8") <= TERMINAL_EVENT_MAX_BYTES &&
          isClaudeResultLine(terminalLineBuffer)
        ) {
          terminalResultLine = terminalLineBuffer;
        }
        if (truncated && terminalResultLine) {
          progressQueue = progressQueue.then(async () => {
            progressSeq = await sendProgressChunks(
              params.client,
              params.frame,
              progressSeq,
              `\n${terminalResultLine}\n`,
            );
          });
        }
        await progressQueue.catch(() => {});
        const timeoutMessage = idleTimedOut
          ? "Claude CLI produced no output before the idle timeout"
          : hardTimedOut
            ? "Claude CLI exceeded the hard timeout"
            : "";
        const finalError = progressError ?? error;
        const cancelledMessage = cancelled ? "Claude CLI invocation cancelled" : "";
        resolve({
          exitCode: exitCode ?? (idleTimedOut || hardTimedOut ? 124 : cancelled ? 130 : 1),
          timedOut: idleTimedOut || hardTimedOut,
          noOutputTimedOut: idleTimedOut,
          success: exitCode === 0 && !idleTimedOut && !hardTimedOut && !cancelled && !finalError,
          stdout: "",
          stderr: truncateUtf8Suffix(
            [stderr, timeoutMessage, cancelledMessage, finalError?.message]
              .filter(Boolean)
              .join("\n"),
            STDERR_TAIL_BYTES,
          ),
          error: finalError?.message ?? null,
          truncated,
        });
      };
      child.once("error", (error) => void finish(null, error));
      child.once("close", (code) => void finish(code));
    });
  } finally {
    if (promptDir) {
      await fs.rm(promptDir, { recursive: true, force: true });
    }
  }
}

export const claudeCliNodeRunLimits = {
  outputBytes: OUTPUT_CAP_BYTES,
  progressChunkBytes: PROGRESS_CHUNK_BYTES,
  stderrTailBytes: STDERR_TAIL_BYTES,
  terminalEventBytes: TERMINAL_EVENT_MAX_BYTES,
} as const;
