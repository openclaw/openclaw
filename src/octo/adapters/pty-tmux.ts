// Octopus Orchestrator -- PtyTmuxAdapter (M2-09)
//
// Full Adapter implementation for pty_tmux. Drives interactive TUI tools
// inside tmux sessions via TmuxManager (M1-10/M1-11).
//
// References:
//   - docs/octopus-orchestrator/LLD.md, PtyTmuxAdapter (line 420)
//   - DECISIONS.md OCTO-DEC-033 (upstream isolation — no src/infra imports)
//   - DECISIONS.md OCTO-DEC-036 (pty_tmux as primary for TUI tools)
//
// Session name convention: `octo-arm-${arm_id}` — shared with M1-13
// SessionReconciler. Inlined here to avoid a circular import.
//
// stream() mechanism: polls `tmux capture-pane -p -t <session>` every
// captureIntervalMs (default 250ms), diffs the full capture against the
// previous snapshot, and yields only the new trailing output as
// AdapterEvent { kind: "output" } chunks. An AbortSignal stops the loop.
//
// send() sends text followed by Enter via `tmux send-keys`. The concrete
// class also exposes `send_keys()` for raw key sequences without an
// implicit Enter.

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TmuxManager } from "../node-agent/tmux-manager.ts";
import type { ArmSpec } from "../wire/schema.ts";
import {
  AdapterError,
  type Adapter,
  type AdapterEvent,
  type CheckpointMeta,
  type SessionRef,
} from "./base.ts";

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────────────────────────────────
// Options
// ──────────────────────────────────────────────────────────────────────────

export interface PtyTmuxAdapterOptions {
  /** Polling interval for stream() capture-pane diffing (ms). Default 250. */
  captureIntervalMs?: number;
  /** Override tmux binary path (forwarded to direct exec calls). */
  tmuxBin?: string;
  /**
   * Directory for sentinel files. The adapter wraps the user command to
   * write `$?` to `<sentinelDir>/<arm_id>.exit` on exit so ProcessWatcher
   * can detect clean vs. failed exits. Defaults to `$TMPDIR/octo-sentinels`.
   */
  sentinelDir?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Session name helper — shared convention with SessionReconciler (M1-13)
// ──────────────────────────────────────────────────────────────────────────

function armSessionName(armId: string): string {
  return `octo-arm-${armId}`;
}

// ──────────────────────────────────────────────────────────────────────────
// PtyTmuxAdapter
// ──────────────────────────────────────────────────────────────────────────

export class PtyTmuxAdapter implements Adapter {
  readonly type = "pty_tmux" as const;

  private readonly captureIntervalMs: number;
  private readonly tmuxBin: string;
  private readonly sentinelDir: string;
  private readonly spawnTimestamps = new Map<string, number>();
  private readonly outputByteCounters = new Map<string, number>();

  constructor(
    private readonly tmuxManager: TmuxManager,
    opts?: PtyTmuxAdapterOptions,
  ) {
    this.captureIntervalMs = opts?.captureIntervalMs ?? 250;
    this.tmuxBin = opts?.tmuxBin ?? "tmux";
    this.sentinelDir = opts?.sentinelDir ?? join(process.env.TMPDIR ?? "/tmp", "octo-sentinels");
  }

  // ── spawn ──────────────────────────────────────────────────────────────

  async spawn(spec: ArmSpec): Promise<SessionRef> {
    const rtOpts = spec.runtime_options as {
      command: string;
      args?: string[];
      tmuxSessionName?: string;
      captureCols?: number;
      captureRows?: number;
    };

    // Derive arm_id from the injected _arm_id field (set by gateway handler)
    // or fall back to the idempotency_key for the session name.
    const armId = (spec as Record<string, unknown>)._arm_id as string | undefined;
    const sessionName = rtOpts.tmuxSessionName ?? armSessionName(armId ?? spec.idempotency_key);

    // Build the command string for tmux new-session. If args are provided,
    // join them space-separated (tmux parses the combined string itself).
    const cmdParts = [rtOpts.command, ...(rtOpts.args ?? [])];
    const userCmd = cmdParts.join(" ");

    // Wrap the user command with sentinel file writing so ProcessWatcher
    // can detect clean exits (exit code 0 → completed, non-zero → failed).
    // Without this wrapper, ProcessWatcher sees "session gone, no sentinel"
    // and always emits failed with reason "session_terminated_no_sentinel".
    //
    // The wrapper captures $? from the user command, writes it to a
    // sentinel file, then exits with the original code. The sentinel path
    // uses the same convention as NodeAgent.sentinelPathForArm().
    let cmd: string;
    if (armId) {
      mkdirSync(this.sentinelDir, { recursive: true });
      const sentinelPath = join(this.sentinelDir, `${armId}.exit`);
      // Sentinel paths are under tmpdir and contain only alphanumeric/dash/dot
      // characters, so direct interpolation is safe.
      cmd = `${userCmd}; echo $? > ${sentinelPath}`;
    } else {
      cmd = userCmd;
    }

    try {
      await this.tmuxManager.createSession(sessionName, cmd, spec.cwd);
    } catch (err) {
      throw new AdapterError("spawn_failed", `pty_tmux spawn failed: ${String(err)}`, {
        sessionName,
      });
    }

    this.spawnTimestamps.set(sessionName, Date.now());
    this.outputByteCounters.set(sessionName, 0);

    return {
      adapter_type: this.type,
      session_id: sessionName,
      attach_command: `tmux attach -t ${sessionName}`,
      cwd: spec.cwd,
      metadata: {
        captureCols: rtOpts.captureCols,
        captureRows: rtOpts.captureRows,
        tmux_session_name: sessionName,
      },
    };
  }

  // ── resume ─────────────────────────────────────────────────────────────

  async resume(ref: SessionRef): Promise<SessionRef> {
    const sessions = await this.tmuxManager.listSessions();
    if (!sessions.includes(ref.session_id)) {
      throw new AdapterError(
        "session_not_found",
        `tmux session "${ref.session_id}" not found for resume`,
      );
    }

    // Populate tracking maps if not already set (e.g. after Node Agent restart)
    if (!this.spawnTimestamps.has(ref.session_id)) {
      this.spawnTimestamps.set(ref.session_id, Date.now());
    }
    if (!this.outputByteCounters.has(ref.session_id)) {
      this.outputByteCounters.set(ref.session_id, 0);
    }

    return {
      ...ref,
      attach_command: `tmux attach -t ${ref.session_id}`,
      metadata: { ...ref.metadata, resumed: true },
    };
  }

  // ── send ───────────────────────────────────────────────────────────────
  //
  // Sends text followed by Enter to the tmux session pane. Uses execFile
  // with an argv array (NOT shell string) for injection safety.

  async send(ref: SessionRef, message: string): Promise<void> {
    try {
      await execFileAsync(this.tmuxBin, ["send-keys", "-t", ref.session_id, message, "Enter"]);
    } catch (err) {
      throw new AdapterError(
        "send_failed",
        `pty_tmux send failed for "${ref.session_id}": ${String(err)}`,
      );
    }
  }

  // ── send_keys (extension) ─────────────────────────────────────────────
  //
  // Raw key sequences without implicit Enter. This is NOT on the Adapter
  // interface — callers that need it must cast to PtyTmuxAdapter.

  async send_keys(ref: SessionRef, keys: string[]): Promise<void> {
    try {
      await execFileAsync(this.tmuxBin, ["send-keys", "-t", ref.session_id, ...keys]);
    } catch (err) {
      throw new AdapterError(
        "send_failed",
        `pty_tmux send_keys failed for "${ref.session_id}": ${String(err)}`,
      );
    }
  }

  // ── stream ─────────────────────────────────────────────────────────────
  //
  // Polls `tmux capture-pane -p -t <session>` every captureIntervalMs.
  // Diffs against the last full capture; yields only new trailing output
  // as AdapterEvent { kind: "output" } chunks. Stops when the AbortSignal
  // fires or when the session is no longer alive.

  async *stream(ref: SessionRef, signal?: AbortSignal): AsyncGenerator<AdapterEvent> {
    let lastCapture = "";

    while (!signal?.aborted) {
      let capture: string;
      try {
        const result = await execFileAsync(this.tmuxBin, [
          "capture-pane",
          "-p",
          "-t",
          ref.session_id,
        ]);
        capture = result.stdout;
      } catch {
        // Session gone — emit completion and stop
        yield {
          kind: "completion",
          ts: Date.now(),
          data: { reason: "session_ended" },
        };
        return;
      }

      if (capture !== lastCapture) {
        // Find the new content. If the new capture starts with the old,
        // emit only the diff; otherwise emit the full capture (screen
        // was redrawn).
        let chunk: string;
        if (capture.startsWith(lastCapture)) {
          chunk = capture.slice(lastCapture.length);
        } else {
          chunk = capture;
        }

        if (chunk.length > 0) {
          const byteLen = Buffer.byteLength(chunk, "utf8");
          const counter = (this.outputByteCounters.get(ref.session_id) ?? 0) + byteLen;
          this.outputByteCounters.set(ref.session_id, counter);

          yield {
            kind: "output",
            ts: Date.now(),
            data: { text: chunk, bytes: byteLen },
          };
        }

        lastCapture = capture;
      }

      // Wait before next poll
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.captureIntervalMs);
        if (signal) {
          const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }

  // ── checkpoint ─────────────────────────────────────────────────────────

  async checkpoint(ref: SessionRef): Promise<CheckpointMeta> {
    const alive = await this.isSessionAlive(ref.session_id);
    const spawnTs = this.spawnTimestamps.get(ref.session_id);
    const outputBytes = this.outputByteCounters.get(ref.session_id) ?? 0;

    let cwd: string | undefined;
    try {
      const result = await execFileAsync(this.tmuxBin, [
        "display-message",
        "-t",
        ref.session_id,
        "-p",
        "#{pane_current_path}",
      ]);
      cwd = result.stdout.trim() || undefined;
    } catch {
      // Session may be dead — cwd is best-effort
    }

    return {
      ts: Date.now(),
      alive,
      cwd,
      output_bytes: outputBytes,
      elapsed_ms: spawnTs !== undefined ? Date.now() - spawnTs : undefined,
      metadata: {
        session_name: ref.session_id,
      },
    };
  }

  // ── terminate ──────────────────────────────────────────────────────────

  async terminate(ref: SessionRef): Promise<void> {
    await this.tmuxManager.killSession(ref.session_id);

    // Verify it is actually gone
    const stillAlive = await this.isSessionAlive(ref.session_id);
    if (stillAlive) {
      throw new AdapterError(
        "internal",
        `pty_tmux terminate: session "${ref.session_id}" still alive after killSession`,
      );
    }

    // Cleanup tracking state
    this.spawnTimestamps.delete(ref.session_id);
    this.outputByteCounters.delete(ref.session_id);
  }

  // ── health ─────────────────────────────────────────────────────────────

  async health(ref: SessionRef): Promise<string> {
    const alive = await this.isSessionAlive(ref.session_id);
    return alive ? "active" : "dead";
  }

  // ── private helpers ────────────────────────────────────────────────────

  private async isSessionAlive(sessionId: string): Promise<boolean> {
    try {
      await execFileAsync(this.tmuxBin, ["has-session", "-t", sessionId]);
      return true;
    } catch {
      return false;
    }
  }
}
