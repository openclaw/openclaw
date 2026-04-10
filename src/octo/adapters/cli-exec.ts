// Octopus Orchestrator -- CliExecAdapter (M2-05 / M2-06 / M2-07)
//
// Adapter implementation for cli_exec. Spawns external CLI tools as raw
// subprocesses (no PTY, no tmux) and manages their lifecycle.
//
// References:
//   - docs/octopus-orchestrator/LLD.md, CliExecAdapter (line 407)
//   - DECISIONS.md OCTO-DEC-033 (upstream isolation -- only node:* builtins)
//   - DECISIONS.md OCTO-DEC-036 (cli_exec as primary for structured CLI tools)
//   - DECISIONS.md OCTO-DEC-037 (cli_exec adapter)
//
// M2-05 scope: spawn, terminate, health, resume.
// M2-06 scope: stream() -- stdout/stderr line-by-line streaming with
//   structuredOutputFormat parsing.
// M2-07 scope: send() -- stdin write; checkpoint() -- full snapshot.

import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ArmSpec } from "../wire/schema.ts";
import {
  AdapterError,
  type Adapter,
  type AdapterEvent,
  type CheckpointMeta,
  type SessionRef,
} from "./base.ts";

// ──────────────────────────────────────────────────────────────────────────
// Internal session record
// ──────────────────────────────────────────────────────────────────────────

/** Structured output format for cli_exec, from CliExecRuntimeOptionsSchema. */
type StructuredOutputFormat = "stream-json" | "json" | "ndjson" | "none";

interface CliExecSession {
  process: ChildProcess;
  cwd: string;
  spawnedAt: number;
  alive: boolean;
  exitCode: number | null;
  /** Total bytes of stdout read so far (M2-07 checkpoint). */
  outputBytes: number;
  /** Structured output format for stream parsing (M2-06). */
  structuredOutputFormat: StructuredOutputFormat;
  /** Buffered stdout lines (captured eagerly from spawn). */
  stdoutLines: string[];
  /** Buffered stderr lines (captured eagerly from spawn). */
  stderrLines: string[];
  /** Whether stdout has closed (process exited or stream ended). */
  stdoutClosed: boolean;
  /** Whether stderr has closed. */
  stderrClosed: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

/** Grace period before SIGKILL escalation (ms). */
const TERMINATE_GRACE_MS = 5_000;

// ──────────────────────────────────────────────────────────────────────────
// CliExecAdapter
// ──────────────────────────────────────────────────────────────────────────

export class CliExecAdapter implements Adapter {
  readonly type = "cli_exec" as const;

  /** Live sessions keyed by session_id (stringified pid). */
  private readonly sessions = new Map<string, CliExecSession>();

  // ── spawn ──────────────────────────────────────────────────────────────

  async spawn(spec: ArmSpec): Promise<SessionRef> {
    const rtOpts = spec.runtime_options as {
      command: string;
      args?: string[];
    };

    const command = rtOpts.command;
    const args = rtOpts.args ?? [];
    const cwd = spec.worktree_path ?? spec.cwd;
    const env = spec.env ? { ...process.env, ...spec.env } : process.env;

    let child: ChildProcess;
    try {
      child = cpSpawn(command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AdapterError("spawn_failed", `spawn failed: ${msg}`);
    }

    // child_process.spawn can fail asynchronously (e.g. ENOENT). We need
    // to detect that before returning the SessionRef. Wait a tick for the
    // error event to fire if it will.
    const pid = child.pid;
    if (pid === undefined) {
      // Synchronous failure -- pid is undefined when spawn itself failed.
      const errorPromise = new Promise<Error>((resolve) => {
        child.once("error", resolve);
        // Safety timeout so we don't hang forever.
        setTimeout(() => resolve(new Error("spawn returned no pid")), 500);
      });
      const err = await errorPromise;
      throw new AdapterError("spawn_failed", `spawn failed: ${err.message}`);
    }

    const sessionId = String(pid);

    const structuredOutputFormat =
      (rtOpts as { structuredOutputFormat?: StructuredOutputFormat }).structuredOutputFormat ??
      "none";

    const session: CliExecSession = {
      process: child,
      cwd,
      spawnedAt: Date.now(),
      alive: true,
      exitCode: null,
      outputBytes: 0,
      structuredOutputFormat,
      stdoutLines: [],
      stderrLines: [],
      stdoutClosed: false,
      stderrClosed: false,
    };

    // Eagerly capture stdout/stderr so data is not lost if stream() is
    // called after the process exits.
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line: string) => {
        session.outputBytes += Buffer.byteLength(line, "utf8");
        session.stdoutLines.push(line);
      });
      rl.on("close", () => {
        session.stdoutClosed = true;
      });
    } else {
      session.stdoutClosed = true;
    }

    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line: string) => {
        session.stderrLines.push(line);
      });
      rl.on("close", () => {
        session.stderrClosed = true;
      });
    } else {
      session.stderrClosed = true;
    }

    // Attach exit listener BEFORE the early-error await so fast-exiting
    // processes (like `echo`) are tracked correctly.
    child.once("exit", (code) => {
      session.alive = false;
      session.exitCode = code;
    });

    // Also catch deferred ENOENT that fires slightly after spawn returns a pid.
    // Give a short window for the error event.
    const earlyError = await new Promise<Error | null>((resolve) => {
      child.once("error", (e: Error) => resolve(e));
      setTimeout(() => resolve(null), 50);
    });

    if (earlyError) {
      throw new AdapterError("spawn_failed", `spawn failed: ${earlyError.message}`);
    }

    this.sessions.set(sessionId, session);

    return {
      adapter_type: this.type,
      session_id: sessionId,
      cwd,
      metadata: { pid },
    };
  }

  // ── resume ─────────────────────────────────────────────────────────────

  async resume(ref: SessionRef): Promise<SessionRef> {
    const session = this.sessions.get(ref.session_id);
    if (!session || !session.alive) {
      throw new AdapterError(
        "session_not_found",
        `session ${ref.session_id} not found or already exited`,
      );
    }

    return {
      adapter_type: this.type,
      session_id: ref.session_id,
      cwd: session.cwd,
      metadata: { pid: session.process.pid },
    };
  }

  // ── send (M2-07) ───────────────────────────────────────────────────────

  async send(ref: SessionRef, message: string): Promise<void> {
    const session = this.sessions.get(ref.session_id);
    if (!session || !session.alive) {
      throw new AdapterError("send_failed", "stdin not available");
    }

    const stdin = session.process.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new AdapterError("send_failed", "stdin not available");
    }

    stdin.write(message + "\n");
  }

  // ── stream (M2-06) ─────────────────────────────────────────────────────

  async *stream(ref: SessionRef): AsyncGenerator<AdapterEvent> {
    const session = this.sessions.get(ref.session_id);
    if (!session) {
      throw new AdapterError("session_not_found", `session ${ref.session_id} not found`);
    }

    const format = session.structuredOutputFormat;

    // Cursor tracking: how many lines we have already consumed from the
    // eagerly-buffered stdout/stderr arrays.
    let stdoutCursor = 0;
    let stderrCursor = 0;

    /** Parse a single stdout line per the structuredOutputFormat. */
    const parseStdoutLine = (line: string): AdapterEvent[] => {
      const events: AdapterEvent[] = [];

      if (format === "stream-json" || format === "ndjson") {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          events.push({ kind: "output", ts: Date.now(), data: parsed });
          // Extract cost metadata if present.
          if ("input_tokens" in parsed || "output_tokens" in parsed || "cost_usd" in parsed) {
            const costData: Record<string, unknown> = {};
            if ("input_tokens" in parsed) {
              costData.input_tokens = parsed.input_tokens;
            }
            if ("output_tokens" in parsed) {
              costData.output_tokens = parsed.output_tokens;
            }
            if ("cost_usd" in parsed) {
              costData.cost_usd = parsed.cost_usd;
            }
            events.push({ kind: "cost", ts: Date.now(), data: costData });
          }
        } catch {
          events.push({ kind: "output", ts: Date.now(), data: { text: line } });
        }
        return events;
      }

      // format === "none" (and "json" lines are handled at exit)
      if (format !== "json") {
        events.push({ kind: "output", ts: Date.now(), data: { text: line } });
      }
      return events;
    };

    // Poll loop: drain buffered lines, then wait for more or process exit.
    // This handles both the fast-exit case (all lines already buffered)
    // and the live-streaming case (lines arriving while we iterate).
    while (true) {
      // Drain any new stdout lines.
      while (stdoutCursor < session.stdoutLines.length) {
        const line = session.stdoutLines[stdoutCursor++];
        for (const evt of parseStdoutLine(line)) {
          yield evt;
        }
      }

      // Check if the process has exited AND all output has been captured.
      if (!session.alive && session.stdoutClosed && session.stderrClosed) {
        break;
      }

      // Wait a tick for more data to arrive.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    // Drain any remaining stdout lines that arrived during the final tick.
    while (stdoutCursor < session.stdoutLines.length) {
      const line = session.stdoutLines[stdoutCursor++];
      for (const evt of parseStdoutLine(line)) {
        yield evt;
      }
    }

    // For "json" mode, parse all buffered stdout as a single JSON blob.
    if (format === "json" && session.stdoutLines.length > 0) {
      const raw = session.stdoutLines.join("\n");
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        yield { kind: "completion", ts: Date.now(), data: parsed };
      } catch {
        yield { kind: "output", ts: Date.now(), data: { text: raw } };
      }
    }

    // Yield stderr events.
    while (stderrCursor < session.stderrLines.length) {
      yield { kind: "error", ts: Date.now(), data: { text: session.stderrLines[stderrCursor++] } };
    }

    // Yield final completion event with exit code.
    yield { kind: "completion", ts: Date.now(), data: { exit_code: session.exitCode } };
  }

  // ── checkpoint (M2-07) ─────────────────────────────────────────────────

  async checkpoint(ref: SessionRef): Promise<CheckpointMeta> {
    const session = this.sessions.get(ref.session_id);
    return {
      ts: Date.now(),
      alive: session?.alive ?? false,
      cwd: session?.cwd,
      pid: session?.process.pid,
      elapsed_ms: session ? Date.now() - session.spawnedAt : undefined,
      output_bytes: session?.outputBytes ?? 0,
    };
  }

  // ── terminate ──────────────────────────────────────────────────────────

  async terminate(ref: SessionRef): Promise<void> {
    const session = this.sessions.get(ref.session_id);
    if (!session) {
      throw new AdapterError("session_not_found", `session ${ref.session_id} not found`);
    }

    if (!session.alive) {
      // Already dead -- nothing to do.
      this.sessions.delete(ref.session_id);
      return;
    }

    const child = session.process;

    // Send SIGTERM first.
    child.kill("SIGTERM");

    // Wait for exit or escalate to SIGKILL after grace period.
    await new Promise<void>((resolve) => {
      if (!session.alive) {
        resolve();
        return;
      }

      const onExit = (): void => {
        clearTimeout(killTimer);
        resolve();
      };

      const killTimer = setTimeout(() => {
        child.removeListener("exit", onExit);
        if (session.alive) {
          child.kill("SIGKILL");
        }
        // Give SIGKILL a moment to take effect.
        const verifyTimer = setTimeout(() => {
          resolve();
        }, 200);
        // Node.js quirk: unref so the timer doesn't keep the process alive.
        if (typeof verifyTimer === "object" && "unref" in verifyTimer) {
          verifyTimer.unref();
        }
      }, TERMINATE_GRACE_MS);

      // Unref so the timer doesn't keep the test runner alive.
      if (typeof killTimer === "object" && "unref" in killTimer) {
        killTimer.unref();
      }

      child.once("exit", onExit);
    });

    this.sessions.delete(ref.session_id);
  }

  // ── health ─────────────────────────────────────────────────────────────

  async health(ref: SessionRef): Promise<string> {
    const session = this.sessions.get(ref.session_id);
    if (!session) {
      return "unknown";
    }
    return session.alive ? "alive" : "dead";
  }
}
