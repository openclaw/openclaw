// Owns the lifecycle of operator terminal sessions: one PTY per open, bound to
// the connection that opened it, streamed back over the gateway event channel.
import { randomUUID } from "node:crypto";
import { spawnTerminalPty, type TerminalPtyHandle } from "./pty.js";

/** Emits one terminal event frame to the single owning connection. */
export type TerminalEventSink = (connId: string, event: string, payload: unknown) => void;

/** Injectable PTY spawner so tests can drive sessions without a real shell. */
export type TerminalSpawner = typeof spawnTerminalPty;

export const TERMINAL_EVENT_DATA = "terminal.data" as const;
export const TERMINAL_EVENT_EXIT = "terminal.exit" as const;

type TerminalExitReason = "process_exit" | "closed" | "disconnected" | "error";

type TerminalSession = {
  id: string;
  connId: string;
  agentId: string;
  cwd: string;
  shell: string;
  pty: TerminalPtyHandle;
  seq: number;
  closed: boolean;
};

/** Bounds concurrent shells so a client cannot exhaust host processes. */
const DEFAULT_MAX_SESSIONS = 24;

export type TerminalSessionManagerOptions = {
  emit: TerminalEventSink;
  spawn?: TerminalSpawner;
  maxSessions?: number;
  env?: NodeJS.ProcessEnv;
};

/** Parameters for a resolved host terminal launch (isolation already checked). */
export type TerminalOpenRequest = {
  connId: string;
  agentId: string;
  cwd: string;
  shell: string;
  args: string[];
  cols: number;
  rows: number;
  env: Record<string, string>;
};

export type TerminalOpenOutcome =
  | { ok: true; sessionId: string; agentId: string; cwd: string; shell: string }
  | { ok: false; code: "limit" | "spawn_failed" | "closed"; message: string };

/** Abort flag shared between a pending open and its connection's disconnect. */
type OpenToken = { aborted: boolean };

/**
 * Tracks live PTY sessions keyed by session id, with a reverse index by
 * connection so a disconnect can tear down every shell it owned.
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly byConn = new Map<string, Set<string>>();
  // Opens still awaiting spawn, keyed by connection. A disconnect flips their
  // abort flag so the resumed open kills the PTY instead of registering an
  // orphan for a dead connection.
  private readonly pendingOpens = new Map<string, Set<OpenToken>>();
  private readonly emit: TerminalEventSink;
  private readonly spawn: TerminalSpawner;
  private readonly maxSessions: number;
  // Slots reserved by opens that are still awaiting spawn. Counted against the
  // cap so concurrent opens cannot all pass the check and exceed maxSessions.
  private opening = 0;

  constructor(options: TerminalSessionManagerOptions) {
    this.emit = options.emit;
    this.spawn = options.spawn ?? spawnTerminalPty;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** Number of live sessions; used by tests and health surfaces. */
  get size(): number {
    return this.sessions.size;
  }

  /** Spawns a shell and wires its output/exit to the owning connection. */
  async open(request: TerminalOpenRequest): Promise<TerminalOpenOutcome> {
    if (this.sessions.size + this.opening >= this.maxSessions) {
      return {
        ok: false,
        code: "limit",
        message: `terminal session limit reached (${this.maxSessions})`,
      };
    }
    // Reserve the slot before the async spawn so it is visible to concurrent opens.
    this.opening += 1;
    const token: OpenToken = { aborted: false };
    this.trackPendingOpen(request.connId, token);
    let pty: TerminalPtyHandle;
    try {
      pty = await this.spawn({
        file: request.shell,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
      });
    } catch (err) {
      this.opening -= 1;
      this.untrackPendingOpen(request.connId, token);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "spawn_failed", message };
    }
    // Hand the reservation over to the live session (synchronous from here — no
    // await — so the counts never both drop).
    this.opening -= 1;
    this.untrackPendingOpen(request.connId, token);
    if (token.aborted) {
      // The owning connection disconnected while the shell was spawning; kill it
      // now rather than register an orphan no one can reach or close.
      try {
        pty.kill();
      } catch {
        // Best-effort; the process may already be gone.
      }
      return { ok: false, code: "closed", message: "connection closed during open" };
    }

    const session: TerminalSession = {
      id: randomUUID(),
      connId: request.connId,
      agentId: request.agentId,
      cwd: request.cwd,
      shell: request.shell,
      pty,
      seq: 0,
      closed: false,
    };
    this.sessions.set(session.id, session);
    let connSessions = this.byConn.get(request.connId);
    if (!connSessions) {
      connSessions = new Set();
      this.byConn.set(request.connId, connSessions);
    }
    connSessions.add(session.id);

    pty.onData((chunk) => {
      if (session.closed) {
        return;
      }
      this.emit(session.connId, TERMINAL_EVENT_DATA, {
        sessionId: session.id,
        seq: session.seq++,
        data: chunk,
      });
    });
    pty.onExit((event) => {
      const signal = event.signal && event.signal !== 0 ? event.signal : null;
      this.finalize(session, "process_exit", { exitCode: event.exitCode ?? null, signal });
    });

    return {
      ok: true,
      sessionId: session.id,
      agentId: session.agentId,
      cwd: session.cwd,
      shell: session.shell,
    };
  }

  /** Writes client input to a session; returns false when the session is gone. */
  write(connId: string, sessionId: string, data: string): boolean {
    const session = this.ownedSession(connId, sessionId);
    if (!session) {
      return false;
    }
    try {
      session.pty.write(data);
      return true;
    } catch {
      this.finalize(session, "error", { error: "write failed" });
      return false;
    }
  }

  /** Applies a new PTY grid size; returns false when the session is gone. */
  resize(connId: string, sessionId: string, cols: number, rows: number): boolean {
    const session = this.ownedSession(connId, sessionId);
    if (!session) {
      return false;
    }
    try {
      session.pty.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  /** Closes one session on operator request. */
  close(connId: string, sessionId: string): boolean {
    const session = this.ownedSession(connId, sessionId);
    if (!session) {
      return false;
    }
    this.finalize(session, "closed", {});
    return true;
  }

  private trackPendingOpen(connId: string, token: OpenToken): void {
    let set = this.pendingOpens.get(connId);
    if (!set) {
      set = new Set();
      this.pendingOpens.set(connId, set);
    }
    set.add(token);
  }

  private untrackPendingOpen(connId: string, token: OpenToken): void {
    const set = this.pendingOpens.get(connId);
    if (set) {
      set.delete(token);
      if (set.size === 0) {
        this.pendingOpens.delete(connId);
      }
    }
  }

  /** Tears down every session a disconnected connection owned. */
  closeForConn(connId: string): void {
    // Abort opens still awaiting spawn so they don't register orphaned PTYs.
    const opens = this.pendingOpens.get(connId);
    if (opens) {
      for (const token of opens) {
        token.aborted = true;
      }
    }
    const ids = this.byConn.get(connId);
    if (!ids) {
      return;
    }
    // Snapshot first: finalize() mutates the same set during iteration.
    for (const id of Array.from(ids)) {
      const session = this.sessions.get(id);
      if (session) {
        this.finalize(session, "disconnected", {}, { silent: true });
      }
    }
    this.byConn.delete(connId);
  }

  /** Kills every session; used on gateway shutdown. */
  /**
   * Tears down every session on gateway shutdown/stop. Silent because the
   * sockets are going away anyway (disabling the terminal is a `gateway`
   * restart, so that path also runs through here, not a live notification).
   */
  disposeAll(): void {
    // Abort any opens still spawning so they don't register after shutdown.
    for (const opens of this.pendingOpens.values()) {
      for (const token of opens) {
        token.aborted = true;
      }
    }
    // Snapshot first: finalize() deletes from this.sessions during iteration.
    for (const session of Array.from(this.sessions.values())) {
      this.finalize(session, "disconnected", {}, { silent: true });
    }
  }

  private ownedSession(connId: string, sessionId: string): TerminalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.connId !== connId || session.closed) {
      return undefined;
    }
    return session;
  }

  private finalize(
    session: TerminalSession,
    reason: TerminalExitReason,
    detail: { exitCode?: number | null; signal?: number | null; error?: string },
    opts?: { silent?: boolean },
  ): void {
    if (session.closed) {
      return;
    }
    session.closed = true;
    this.sessions.delete(session.id);
    this.byConn.get(session.connId)?.delete(session.id);
    try {
      session.pty.kill();
    } catch {
      // Process may already be gone; the kill is best-effort teardown.
    }
    // A disconnect already dropped the socket, so emitting there is pointless;
    // process/close/error exits still notify the live client.
    if (!opts?.silent) {
      this.emit(session.connId, TERMINAL_EVENT_EXIT, {
        sessionId: session.id,
        exitCode: detail.exitCode ?? null,
        signal: detail.signal ?? null,
        reason,
        ...(detail.error ? { error: detail.error } : {}),
      });
    }
  }
}
