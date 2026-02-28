import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB output cap

function resolveAbsPath(input: string | undefined): string {
  if (!input || !input.trim()) {
    return os.homedir();
  }
  const trimmed = input.trim();
  if (trimmed.startsWith("~")) {
    return path.resolve(os.homedir(), trimmed.slice(1).replace(/^\//, ""));
  }
  return path.resolve(trimmed);
}

// ---------------------------------------------------------------------------
// FS types
// ---------------------------------------------------------------------------

type FsListParams = {
  path?: string;
};

type FsReadParams = {
  path?: string;
  maxBytes?: number;
};

// ---------------------------------------------------------------------------
// PTY types & state
// ---------------------------------------------------------------------------

// Re-declare minimal PTY types to avoid import issues (native module)
type PtyExitEvent = { exitCode: number; signal?: number };
type PtyHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  resize: (columns: number, rows: number) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: PtyExitEvent) => void) => void;
};
type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtyHandle;

type PtySession = {
  pty: PtyHandle;
  connId: string;
  createdAt: number;
};

/** One PTY per client connection. Keyed by connId. */
const ptySessions = new Map<string, PtySession>();

/** Guard against concurrent pty.spawn for the same connId. */
const ptySpawning = new Set<string>();

/**
 * ConnIds whose connection closed while a spawn was in-flight.
 * Checked after the async gap so we can immediately kill the orphan.
 */
const ptyCancelled = new Set<string>();

const MAX_PTY_SESSIONS = 8;
const PTY_DATA_EVENT = "pty.data";
const PTY_EXIT_EVENT = "pty.exit";

type PtySpawnParams = {
  cols?: number;
  rows?: number;
  cwd?: string;
};

type PtyInputParams = {
  data?: string;
};

type PtyResizeParams = {
  cols?: number;
  rows?: number;
};

async function loadPtySpawn(): Promise<PtySpawn> {
  const mod = (await import("@lydell/node-pty")) as unknown as {
    spawn?: PtySpawn;
    default?: { spawn?: PtySpawn };
  };
  const fn = mod.spawn ?? mod.default?.spawn;
  if (!fn) {
    throw new Error("node-pty spawn not available");
  }
  return fn;
}

function getDefaultShell(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

/** Clean up a PTY session. */
function destroySession(connId: string): boolean {
  const session = ptySessions.get(connId);
  if (!session) {
    return false;
  }
  ptySessions.delete(connId);
  try {
    session.pty.kill();
  } catch {
    // already dead
  }
  return true;
}

export function cleanupPtySessions(): void {
  for (const [connId] of ptySessions) {
    destroySession(connId);
  }
}

export function cleanupPtyForConn(connId: string): void {
  destroySession(connId);
  // If a spawn is in-flight for this connId, mark it cancelled so
  // ptySpawnInner will kill the child as soon as the async gap resolves.
  if (ptySpawning.has(connId)) {
    ptyCancelled.add(connId);
  }
}

// ---------------------------------------------------------------------------
// PTY spawn inner (extracted to keep the guard clean)
// ---------------------------------------------------------------------------

async function ptySpawnInner(
  connId: string,
  p: PtySpawnParams,
  context: GatewayRequestContext,
  respond: RespondFn,
): Promise<void> {
  const cols = typeof p?.cols === "number" && p.cols > 0 ? p.cols : 80;
  const rows = typeof p?.rows === "number" && p.rows > 0 ? p.rows : 24;
  const cwd = resolveAbsPath(p?.cwd);

  let spawnPty: PtySpawn;
  try {
    spawnPty = await loadPtySpawn();
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `PTY unavailable: ${String(err)}`),
    );
    return;
  }

  // Connection closed while we were loading the native module — abort early.
  if (ptyCancelled.has(connId)) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "connection closed during spawn"));
    return;
  }

  const shell = getDefaultShell();
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  try {
    const pty = spawnPty(shell, [], { name: "xterm-256color", cols, rows, cwd, env });

    // Connection closed while the synchronous spawn was running — kill
    // the child immediately so it doesn't become an unmanaged orphan.
    if (ptyCancelled.has(connId)) {
      try {
        pty.kill();
      } catch {
        // best-effort
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "connection closed during spawn"),
      );
      return;
    }

    const session: PtySession = { pty, connId, createdAt: Date.now() };
    ptySessions.set(connId, session);

    // Stream data from PTY to client via gateway events
    const connIdSet = new Set([connId]);
    pty.onData((data: string) => {
      context.broadcastToConnIds(PTY_DATA_EVENT, { data }, connIdSet);
    });

    pty.onExit((ev: PtyExitEvent) => {
      // Only broadcast exit and clean up if this PTY is still the mapped
      // session — a replacement spawn may already be active.
      const current = ptySessions.get(connId);
      if (current && current.pty === pty) {
        context.broadcastToConnIds(
          PTY_EXIT_EVENT,
          { exitCode: ev.exitCode, signal: ev.signal },
          connIdSet,
        );
        ptySessions.delete(connId);
      }
    });

    respond(true, { pid: pty.pid, cols, rows, shell }, undefined);
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `spawn failed: ${String(err)}`));
  }
}

// ---------------------------------------------------------------------------
// All shell handlers (fs + pty)
// ---------------------------------------------------------------------------

export const shellHandlers: GatewayRequestHandlers = {
  // ── File system ──────────────────────────────────────────────────────

  /**
   * List directory contents (files and subdirectories).
   */
  "fs.list": async ({ params, respond }) => {
    const p = params as FsListParams;
    const dirPath = resolveAbsPath(p.path);

    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `not a directory: ${dirPath}`),
        );
        return;
      }
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `path not found: ${dirPath}`),
      );
      return;
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const items = entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          path: path.join(dirPath, entry.name),
        }))
        .toSorted((a, b) => {
          // Directories first, then alphabetical
          if (a.type === "directory" && b.type !== "directory") {
            return -1;
          }
          if (a.type !== "directory" && b.type === "directory") {
            return 1;
          }
          return a.name.localeCompare(b.name);
        });

      respond(true, { path: dirPath, entries: items }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `failed to list: ${String(err)}`),
      );
    }
  },

  /**
   * Read file contents (text, capped).
   */
  "fs.read": async ({ params, respond }) => {
    const p = params as FsReadParams;
    if (typeof p.path !== "string" || !p.path.trim()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "path is required"));
      return;
    }

    const filePath = resolveAbsPath(p.path);
    const maxBytes =
      typeof p.maxBytes === "number" && p.maxBytes > 0
        ? Math.min(p.maxBytes, MAX_OUTPUT_BYTES)
        : MAX_OUTPUT_BYTES;

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `path is a directory: ${filePath}`),
        );
        return;
      }

      const handle = await fs.open(filePath, "r");
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, stat.size));
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        const content = buf.slice(0, bytesRead).toString("utf-8");
        respond(
          true,
          {
            path: filePath,
            size: stat.size,
            truncated: stat.size > maxBytes,
            content,
          },
          undefined,
        );
      } finally {
        await handle.close();
      }
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `failed to read: ${String(err)}`),
      );
    }
  },

  // ── PTY ──────────────────────────────────────────────────────────────

  /**
   * Spawn a new PTY session for the calling client.
   * If one already exists for this connId, kill it first.
   */
  "pty.spawn": async ({ client, params, context, respond }) => {
    const connId = typeof client?.connId === "string" ? client.connId : undefined;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no connId"));
      return;
    }

    // Prevent concurrent spawns for the same connId
    if (ptySpawning.has(connId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "spawn already in progress"),
      );
      return;
    }

    // Enforce limit — count in-flight spawns so concurrent requests from
    // different connIds cannot collectively exceed the cap across the async gap.
    const effectiveCount = ptySessions.size + ptySpawning.size;
    if (effectiveCount >= MAX_PTY_SESSIONS && !ptySessions.has(connId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "too many PTY sessions"));
      return;
    }

    // Kill existing session for this client
    destroySession(connId);

    ptySpawning.add(connId);
    try {
      await ptySpawnInner(connId, params as PtySpawnParams, context, respond);
    } finally {
      ptySpawning.delete(connId);
      ptyCancelled.delete(connId);
    }
  },

  /**
   * Write data (keystrokes) to the PTY.
   */
  "pty.input": async ({ client, respond, params }) => {
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no connId"));
      return;
    }
    const session = ptySessions.get(connId);
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no PTY session"));
      return;
    }
    const p = params as PtyInputParams;
    if (typeof p?.data !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "data is required"));
      return;
    }
    try {
      session.pty.write(p.data);
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `write failed: ${String(err)}`));
    }
  },

  /**
   * Resize the PTY.
   */
  "pty.resize": async ({ client, respond, params }) => {
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no connId"));
      return;
    }
    const session = ptySessions.get(connId);
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no PTY session"));
      return;
    }
    const p = params as PtyResizeParams;
    const cols = typeof p?.cols === "number" && p.cols > 0 ? p.cols : undefined;
    const rows = typeof p?.rows === "number" && p.rows > 0 ? p.rows : undefined;
    if (!cols || !rows) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cols and rows are required"),
      );
      return;
    }
    try {
      session.pty.resize(cols, rows);
      respond(true, { cols, rows }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `resize failed: ${String(err)}`),
      );
    }
  },

  /**
   * Kill the PTY session.
   */
  "pty.kill": async ({ client, respond }) => {
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no connId"));
      return;
    }
    const destroyed = destroySession(connId);
    respond(true, { killed: destroyed }, undefined);
  },
};
