// Octopus Orchestrator — Node Agent TmuxManager (M1-10; M1-11 added enumerateExisting())
//
// References:
//   - LLD.md §"Node Agent Internals" (TmuxManager is one of the Node Agent
//     modules; responsible for local tmux session lifecycle so that
//     pty_tmux adapter work and SessionReconciler can share a single
//     primitive for "what live tmux sessions does this habitat have?").
//   - HLD.md §"tmux as a Foundational Substrate" — we rely on tmux's
//     detached-session durability so arms survive Node Agent restarts
//     and can be reattached by humans or the reconciler.
//   - DECISIONS.md OCTO-DEC-036 — pty_tmux is primary for external
//     agentic coding tools that only expose interactive TUIs, making a
//     robust local tmux primitive load-bearing for Milestone 2.
//   - DECISIONS.md OCTO-DEC-033 — no imports from src/infra/* (OpenClaw
//     upstream code). This file depends only on node: builtins and is
//     self-contained on that axis.
//
// Developed against: tmux 3.6a.
//
// Scope for M1-10: create / list / kill primitives only. Enumeration of
// pre-existing sessions with metadata (`enumerateExisting()`) is
// explicitly M1-11 work and intentionally not implemented here; the
// class is structured so it can be added without refactoring private
// helpers.

import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Metadata shape for a live tmux session. Fields beyond `name` are
 * best-effort — tmux does not always expose them consistently across
 * versions, and M1-10 consumers only require `name`.
 */
export interface TmuxSessionInfo {
  name: string;
  created_ts?: number;
  cwd?: string;
  windows?: number;
}

/**
 * Construction-time options for {@link TmuxManager}. `tmuxBin` is the
 * primary escape hatch for tests that need to point at a stub binary.
 */
export interface TmuxManagerOptions {
  /** Override tmux binary path. Defaults to `"tmux"` (PATH lookup). */
  tmuxBin?: string;
  /**
   * Optional name prefix. Not enforced by the manager for M1-10 — it is
   * stored for future use by callers that want scoped naming conventions
   * (e.g. the Node Agent prefixing sessions with `octo-<nodeId>-`).
   */
  envPrefix?: string;
}

/**
 * Error thrown by {@link TmuxManager} when a tmux subprocess fails in a
 * way the caller must handle. Exposes stderr, exit code, and the exact
 * argv that was executed so callers can log with full fidelity.
 */
export class TmuxError extends Error {
  readonly stderr: string;
  readonly code: number;
  readonly command: string[];

  constructor(message: string, fields: { stderr: string; code: number; command: string[] }) {
    super(message);
    this.name = "TmuxError";
    this.stderr = fields.stderr;
    this.code = fields.code;
    this.command = fields.command;
  }
}

/**
 * Validates a candidate session name. Rejects: `.`, `:`, any whitespace,
 * ASCII control characters (0x00–0x1f) and DEL (0x7f). The regex is
 * explicit (not a character class with control-char escapes) to avoid
 * the `no-control-regex` lint while still being clear about intent.
 */
function containsForbiddenNameChar(name: string): boolean {
  if (/[.:\s]/.test(name)) {
    return true;
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

interface ExecFileErrorShape {
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  code?: number | string;
  message: string;
}

function isExecFileError(err: unknown): err is ExecFileErrorShape {
  return typeof err === "object" && err !== null && "message" in err;
}

function errStderr(err: unknown): string {
  if (!isExecFileError(err)) {
    return "";
  }
  const s = err.stderr;
  if (s === undefined) {
    return "";
  }
  return typeof s === "string" ? s : s.toString("utf8");
}

function errCode(err: unknown): number {
  if (!isExecFileError(err)) {
    return -1;
  }
  const c = err.code;
  if (typeof c === "number") {
    return c;
  }
  if (typeof c === "string") {
    const parsed = Number.parseInt(c, 10);
    return Number.isNaN(parsed) ? -1 : parsed;
  }
  return -1;
}

/**
 * TmuxManager — minimal, injection-safe wrapper around the `tmux` CLI
 * for local session lifecycle management.
 *
 * Server scope: all operations target the default tmux server (the one
 * selected by the current `TMUX_TMPDIR` env). Callers wanting a
 * non-default server must spawn the process with a different env; this
 * class does not currently abstract per-server routing.
 */
export class TmuxManager {
  private readonly tmuxBin: string;
  readonly envPrefix: string | undefined;

  constructor(opts: TmuxManagerOptions = {}) {
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    this.envPrefix = opts.envPrefix;
  }

  /**
   * Create a detached tmux session with the given name running `cmd`
   * in `cwd`. Returns the session name unchanged on success.
   *
   * `cmd` is passed verbatim to `tmux new-session` as the session's
   * startup command. tmux parses it using its own argv handling — it
   * does NOT invoke a shell. Callers that need shell features (pipes,
   * redirects, env expansion) must wrap their command themselves, e.g.
   * by passing `"/bin/sh -c 'actual command'"` — note that even that
   * form is subject to tmux's own tokenization. The safest pattern is
   * to pre-compose commands that do not rely on shell parsing.
   *
   * @throws {TmuxError} if tmux rejects the request.
   * @throws {Error} if `name` or `cwd` fail pre-flight validation.
   */
  async createSession(name: string, cmd: string, cwd: string): Promise<string> {
    this.validateSessionName(name);
    this.validateCwd(cwd);

    if (typeof cmd !== "string" || cmd.length === 0) {
      throw new Error("TmuxManager.createSession: cmd must be a non-empty string");
    }

    const args = ["new-session", "-d", "-s", name, "-c", cwd, cmd];
    try {
      await execFileAsync(this.tmuxBin, args);
      return name;
    } catch (err) {
      throw new TmuxError(
        `tmux new-session failed for "${name}": ${errStderr(err).trim() || (isExecFileError(err) ? err.message : String(err))}`,
        { stderr: errStderr(err), code: errCode(err), command: [this.tmuxBin, ...args] },
      );
    }
  }

  /**
   * Return the names of all live sessions on the default tmux server.
   *
   * If no tmux server is running (tmux exits with "no server running
   * on ..."), this is treated as an empty fleet and returns `[]` — a
   * missing server is semantically equivalent to zero sessions.
   */
  async listSessions(): Promise<string[]> {
    const args = ["list-sessions", "-F", "#{session_name}"];
    try {
      const { stdout } = await execFileAsync(this.tmuxBin, args);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      const stderr = errStderr(err);
      if (/no server running/i.test(stderr)) {
        return [];
      }
      throw new TmuxError(
        `tmux list-sessions failed: ${stderr.trim() || (isExecFileError(err) ? err.message : String(err))}`,
        { stderr, code: errCode(err), command: [this.tmuxBin, ...args] },
      );
    }
  }

  /**
   * Enumerate ALL live tmux sessions on the default tmux server with
   * structured metadata. Added in M1-11 as the data source for
   * SessionReconciler, which compares live sessions against persisted
   * ArmRecords on Node Agent startup to detect recovered arms, orphaned
   * sessions, and missing expected sessions.
   *
   * Returns every session — NOT filtered by `envPrefix`. The reconciler
   * decides which sessions are relevant; this primitive is deliberately
   * scope-agnostic.
   *
   * Fields:
   *   - `name`: tmux session name (verbatim).
   *   - `created_ts`: unix milliseconds (tmux's `#{session_created}` is
   *     unix seconds; we multiply by 1000 so the rest of the codebase
   *     can treat it as unix millis). `undefined` if tmux did not
   *     populate the field.
   *   - `cwd`: best-effort cwd of the session's active pane
   *     (`#{pane_current_path}`). This may DIFFER from the cwd the
   *     session was originally created with if the user (or the
   *     in-session command) has `cd`'d elsewhere. Callers that need the
   *     original cwd must persist it themselves at creation time.
   *     `undefined` if tmux returned an empty value (can happen in the
   *     narrow window where a session has no panes).
   *   - `windows`: number of windows in the session
   *     (`#{session_windows}`). `undefined` if unparseable.
   *
   * Delimiter choice: the format string uses `\x01` (SOH, Start-of-
   * Heading) as the field separator. tmux's format output passes SOH
   * through verbatim, and no realistic session name, filesystem path,
   * or numeric field will ever contain it — whereas `|` IS a legal
   * character in tmux session names, so a pipe delimiter would be
   * ambiguous for pathological names.
   *
   * Empty-fleet behaviour mirrors {@link listSessions}: if no tmux
   * server is running, returns `[]` instead of throwing.
   */
  async enumerateExisting(): Promise<TmuxSessionInfo[]> {
    const DELIM = "\x01";
    const format =
      `#{session_name}${DELIM}` +
      `#{session_created}${DELIM}` +
      `#{pane_current_path}${DELIM}` +
      `#{session_windows}`;
    const args = ["list-sessions", "-F", format];
    let stdout: string;
    try {
      const result = await execFileAsync(this.tmuxBin, args);
      stdout = result.stdout;
    } catch (err) {
      const stderr = errStderr(err);
      if (/no server running/i.test(stderr)) {
        return [];
      }
      throw new TmuxError(
        `tmux list-sessions (enumerateExisting) failed: ${stderr.trim() || (isExecFileError(err) ? err.message : String(err))}`,
        { stderr, code: errCode(err), command: [this.tmuxBin, ...args] },
      );
    }

    const out: TmuxSessionInfo[] = [];
    const lines = stdout.split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0) {
        continue;
      }
      const parts = line.split(DELIM);
      if (parts.length < 1 || parts[0].length === 0) {
        throw new Error(
          `TmuxManager.enumerateExisting: malformed session line: ${JSON.stringify(raw)}`,
        );
      }
      const name = parts[0];
      const createdRaw = parts[1];
      const cwdRaw = parts[2];
      const windowsRaw = parts[3];

      let created_ts: number | undefined;
      if (createdRaw !== undefined && createdRaw.length > 0) {
        const secs = Number.parseInt(createdRaw, 10);
        if (Number.isFinite(secs)) {
          created_ts = secs * 1000;
        }
      }

      const cwd = cwdRaw !== undefined && cwdRaw.length > 0 ? cwdRaw : undefined;

      let windows: number | undefined;
      if (windowsRaw !== undefined && windowsRaw.length > 0) {
        const w = Number.parseInt(windowsRaw, 10);
        if (Number.isFinite(w) && w >= 0) {
          windows = w;
        }
      }

      const info: TmuxSessionInfo = { name };
      if (created_ts !== undefined) {
        info.created_ts = created_ts;
      }
      if (cwd !== undefined) {
        info.cwd = cwd;
      }
      if (windows !== undefined) {
        info.windows = windows;
      }
      out.push(info);
    }
    return out;
  }

  /**
   * Kill a tmux session by name. Returns `true` if tmux killed it and
   * `false` if the session did not exist (idempotent — "already gone"
   * is treated as a success-like outcome for the caller who wanted it
   * gone). Any other failure throws {@link TmuxError}.
   */
  async killSession(name: string): Promise<boolean> {
    this.validateSessionName(name);
    const args = ["kill-session", "-t", name];
    try {
      await execFileAsync(this.tmuxBin, args);
      return true;
    } catch (err) {
      const stderr = errStderr(err);
      if (/can't find session|no server running/i.test(stderr)) {
        return false;
      }
      throw new TmuxError(
        `tmux kill-session failed for "${name}": ${stderr.trim() || (isExecFileError(err) ? err.message : String(err))}`,
        { stderr, code: errCode(err), command: [this.tmuxBin, ...args] },
      );
    }
  }

  /**
   * Synchronous tmux availability probe. Useful for tests that want to
   * skip themselves when tmux is not installed. Returns `true` if the
   * binary responds to `-V`.
   */
  static isAvailable(tmuxBin = "tmux"): boolean {
    try {
      execFileSync(tmuxBin, ["-V"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private validateSessionName(name: string): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("TmuxManager: session name must be a non-empty string");
    }
    if (containsForbiddenNameChar(name)) {
      throw new Error(
        `TmuxManager: session name "${name}" contains forbidden characters (., :, whitespace, or control chars)`,
      );
    }
  }

  private validateCwd(cwd: string): void {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new Error("TmuxManager: cwd must be a non-empty string");
    }
    let stat;
    try {
      stat = statSync(cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`TmuxManager: cwd "${cwd}" is not accessible: ${msg}`, { cause: err });
    }
    if (!stat.isDirectory()) {
      throw new Error(`TmuxManager: cwd "${cwd}" is not a directory`);
    }
  }
}
