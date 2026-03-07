import crypto from "node:crypto";
import { getShellConfig } from "../../agents/shell-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import { createRunRegistry } from "./registry.js";
import type {
  ManagedRun,
  OverallTimeoutPolicy,
  ProcessSupervisor,
  RunExit,
  RunOutputActivity,
  RunRecord,
  SpawnInput,
  TerminationReason,
} from "./types.js";

const log = createSubsystemLogger("process/supervisor");

type ActiveRun = {
  run: ManagedRun;
  scopeKey?: string;
};

const DEFAULT_OUTPUT_TAIL_LINES = 20;
const DEFAULT_OUTPUT_TAIL_MAX_CHARS = 4_000;

function clampTimeout(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function clampRange(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isTimeoutReason(reason: TerminationReason) {
  return reason === "overall-timeout" || reason === "no-output-timeout";
}

function createOutputTailCapture(params: { maxLines: number; maxChars: number }) {
  const maxLines = Math.max(1, params.maxLines);
  const maxChars = Math.max(200, params.maxChars);
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  let pendingStdout = "";
  let pendingStderr = "";

  const trimLine = (line: string) => {
    if (line.length <= maxChars) {
      return line;
    }
    truncated = true;
    return line.slice(-maxChars);
  };

  const pushLine = (line: string) => {
    const normalized = trimLine(line);
    lines.push(normalized);
    chars += normalized.length + 1;
    while (lines.length > maxLines || chars > maxChars) {
      const removed = lines.shift();
      if (!removed) {
        break;
      }
      chars -= removed.length + 1;
      truncated = true;
    }
  };

  const append = (stream: "stdout" | "stderr", chunk: string) => {
    const prefix = stream === "stdout" ? "stdout> " : "stderr> ";
    const current = stream === "stdout" ? pendingStdout : pendingStderr;
    const merged = `${current}${chunk}`.replaceAll("\r\n", "\n");
    const parts = merged.split("\n");
    const remainder = parts.pop() ?? "";
    for (const part of parts) {
      pushLine(`${prefix}${part}`);
    }
    if (stream === "stdout") {
      pendingStdout = remainder;
    } else {
      pendingStderr = remainder;
    }
  };

  const flush = () => {
    if (pendingStdout.length > 0) {
      pushLine(`stdout> ${pendingStdout}`);
      pendingStdout = "";
    }
    if (pendingStderr.length > 0) {
      pushLine(`stderr> ${pendingStderr}`);
      pendingStderr = "";
    }
  };

  const snapshot = () => ({
    lines: [...lines],
    truncated,
    maxLines,
    maxChars,
  });

  return {
    append,
    flush,
    snapshot,
  };
}

export function createProcessSupervisor(): ProcessSupervisor {
  const registry = createRunRegistry();
  const active = new Map<string, ActiveRun>();

  const cancel = (runId: string, reason: TerminationReason = "manual-cancel") => {
    const current = active.get(runId);
    if (!current) {
      return;
    }
    registry.updateState(runId, "exiting", {
      terminationReason: reason,
    });
    current.run.cancel(reason);
  };

  const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
    if (!scopeKey.trim()) {
      return;
    }
    for (const [runId, run] of active.entries()) {
      if (run.scopeKey !== scopeKey) {
        continue;
      }
      cancel(runId, reason);
    }
  };

  const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
    const runId = input.runId?.trim() || crypto.randomUUID();
    if (input.replaceExistingScope && input.scopeKey?.trim()) {
      cancelScope(input.scopeKey, "manual-cancel");
    }
    const startedAtMs = Date.now();
    const record: RunRecord = {
      runId,
      sessionId: input.sessionId,
      backendId: input.backendId,
      scopeKey: input.scopeKey?.trim() || undefined,
      state: "starting",
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    let forcedReason: TerminationReason | null = null;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let overallTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const captureOutput = input.captureOutput !== false;

    const overallTimeoutMs = clampTimeout(input.timeoutMs);
    const overallMaxMs = clampTimeout(input.overallMaxMs);
    const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);
    const overallTimeoutPolicy: OverallTimeoutPolicy = input.overallTimeoutPolicy ?? "fixed";
    const outputTail = createOutputTailCapture({
      maxLines: clampRange(input.outputTailLines, 1, 200, DEFAULT_OUTPUT_TAIL_LINES),
      maxChars: clampRange(input.outputTailMaxChars, 200, 40_000, DEFAULT_OUTPUT_TAIL_MAX_CHARS),
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutChunks = 0;
    let stderrChunks = 0;
    let lastOutputAtMs = startedAtMs;
    let overallDeadlineAtMs = overallTimeoutMs ? startedAtMs + overallTimeoutMs : undefined;
    const overallHardDeadlineAtMs = overallMaxMs ? startedAtMs + overallMaxMs : undefined;

    const setForcedReason = (reason: TerminationReason) => {
      if (forcedReason) {
        return;
      }
      forcedReason = reason;
      registry.updateState(runId, "exiting", { terminationReason: reason });
    };

    let cancelAdapter: ((reason: TerminationReason) => void) | null = null;

    const requestCancel = (reason: TerminationReason) => {
      setForcedReason(reason);
      cancelAdapter?.(reason);
    };

    const scheduleOverallTimer = () => {
      if (settled) {
        return;
      }
      if (overallTimer) {
        clearTimeout(overallTimer);
        overallTimer = null;
      }
      const now = Date.now();
      const remainingSoft =
        typeof overallDeadlineAtMs === "number"
          ? overallDeadlineAtMs - now
          : Number.POSITIVE_INFINITY;
      const remainingHard =
        typeof overallHardDeadlineAtMs === "number"
          ? overallHardDeadlineAtMs - now
          : Number.POSITIVE_INFINITY;
      const remaining = Math.min(remainingSoft, remainingHard);
      if (!Number.isFinite(remaining)) {
        return;
      }
      if (remaining <= 0) {
        requestCancel("overall-timeout");
        return;
      }
      overallTimer = setTimeout(
        () => {
          if (settled) {
            return;
          }
          const ts = Date.now();
          if (
            (typeof overallHardDeadlineAtMs === "number" && ts >= overallHardDeadlineAtMs) ||
            (typeof overallDeadlineAtMs === "number" && ts >= overallDeadlineAtMs)
          ) {
            requestCancel("overall-timeout");
            return;
          }
          scheduleOverallTimer();
        },
        Math.max(1, Math.floor(remaining)),
      );
    };

    const touchOutput = () => {
      const ts = Date.now();
      lastOutputAtMs = ts;
      registry.touchOutput(runId);
      if (overallTimeoutPolicy === "extend-on-output" && overallTimeoutMs) {
        overallDeadlineAtMs = ts + overallTimeoutMs;
        scheduleOverallTimer();
      }
      if (!noOutputTimeoutMs || settled) {
        return;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        requestCancel("no-output-timeout");
      }, noOutputTimeoutMs);
    };

    try {
      if (input.mode === "child" && input.argv.length === 0) {
        throw new Error("spawn argv cannot be empty");
      }
      const adapter =
        input.mode === "pty"
          ? await (async () => {
              const { shell, args: shellArgs } = getShellConfig();
              const ptyCommand = input.ptyCommand.trim();
              if (!ptyCommand) {
                throw new Error("PTY command cannot be empty");
              }
              return await createPtyAdapter({
                shell,
                args: [...shellArgs, ptyCommand],
                cwd: input.cwd,
                env: input.env,
              });
            })()
          : await createChildAdapter({
              argv: input.argv,
              cwd: input.cwd,
              env: input.env,
              windowsVerbatimArguments: input.windowsVerbatimArguments,
              input: input.input,
              stdinMode: input.stdinMode,
            });

      registry.updateState(runId, "running", { pid: adapter.pid });

      const clearTimers = () => {
        if (overallTimer) {
          clearTimeout(overallTimer);
          overallTimer = null;
        }
        if (noOutputTimer) {
          clearTimeout(noOutputTimer);
          noOutputTimer = null;
        }
      };

      cancelAdapter = (_reason: TerminationReason) => {
        if (settled) {
          return;
        }
        adapter.kill("SIGKILL");
      };

      if (overallTimeoutMs || overallHardDeadlineAtMs) {
        scheduleOverallTimer();
      }
      if (noOutputTimeoutMs) {
        noOutputTimer = setTimeout(() => {
          requestCancel("no-output-timeout");
        }, noOutputTimeoutMs);
      }

      adapter.onStdout((chunk) => {
        if (captureOutput) {
          stdout += chunk;
        }
        stdoutBytes += Buffer.byteLength(chunk);
        stdoutChunks += 1;
        outputTail.append("stdout", chunk);
        input.onStdout?.(chunk);
        touchOutput();
      });
      adapter.onStderr((chunk) => {
        if (captureOutput) {
          stderr += chunk;
        }
        stderrBytes += Buffer.byteLength(chunk);
        stderrChunks += 1;
        outputTail.append("stderr", chunk);
        input.onStderr?.(chunk);
        touchOutput();
      });

      const buildOutputActivity = (): RunOutputActivity => {
        outputTail.flush();
        return {
          lastOutputAtMs,
          silenceMs: Math.max(0, Date.now() - lastOutputAtMs),
          stdoutBytes,
          stderrBytes,
          stdoutChunks,
          stderrChunks,
          tail: outputTail.snapshot(),
        };
      };

      const waitPromise = (async (): Promise<RunExit> => {
        const result = await adapter.wait();
        if (settled) {
          return {
            reason: forcedReason ?? "exit",
            exitCode: result.code,
            exitSignal: result.signal,
            durationMs: Date.now() - startedAtMs,
            stdout,
            stderr,
            timedOut: isTimeoutReason(forcedReason ?? "exit"),
            noOutputTimedOut: forcedReason === "no-output-timeout",
            outputActivity: buildOutputActivity(),
          };
        }
        settled = true;
        clearTimers();
        adapter.dispose();
        active.delete(runId);

        const reason: TerminationReason =
          forcedReason ?? (result.signal != null ? ("signal" as const) : ("exit" as const));
        const exit: RunExit = {
          reason,
          exitCode: result.code,
          exitSignal: result.signal,
          durationMs: Date.now() - startedAtMs,
          stdout,
          stderr,
          timedOut: isTimeoutReason(forcedReason ?? reason),
          noOutputTimedOut: forcedReason === "no-output-timeout",
          outputActivity: buildOutputActivity(),
        };
        registry.finalize(runId, {
          reason: exit.reason,
          exitCode: exit.exitCode,
          exitSignal: exit.exitSignal,
        });
        return exit;
      })().catch((err) => {
        if (!settled) {
          settled = true;
          clearTimers();
          active.delete(runId);
          adapter.dispose();
          registry.finalize(runId, {
            reason: "spawn-error",
            exitCode: null,
            exitSignal: null,
          });
        }
        throw err;
      });

      const managedRun: ManagedRun = {
        runId,
        pid: adapter.pid,
        startedAtMs,
        stdin: adapter.stdin,
        wait: async () => await waitPromise,
        cancel: (reason = "manual-cancel") => {
          requestCancel(reason);
        },
      };

      active.set(runId, {
        run: managedRun,
        scopeKey: input.scopeKey?.trim() || undefined,
      });
      return managedRun;
    } catch (err) {
      registry.finalize(runId, {
        reason: "spawn-error",
        exitCode: null,
        exitSignal: null,
      });
      log.warn(`spawn failed: runId=${runId} reason=${String(err)}`);
      throw err;
    }
  };

  return {
    spawn,
    cancel,
    cancelScope,
    reconcileOrphans: async () => {
      // Deliberate no-op: this supervisor uses in-memory ownership only.
      // Active runs are not recovered after process restart in the current model.
    },
    getRecord: (runId: string) => registry.get(runId),
  };
}
