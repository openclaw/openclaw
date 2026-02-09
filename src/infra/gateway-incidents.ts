import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveRestartSentinelPath } from "./restart-sentinel.js";

export type GatewayIncidentKind = "start" | "signal" | "crash" | "recover";

export type GatewayIncidentEntry = {
  ts: number;
  kind: GatewayIncidentKind;
  pid?: number;
  /** Restart count at time of incident (best-effort). */
  restartCount?: number;
  /** Best-effort reason for the (re)start (e.g., crash/recover/config-apply). */
  restartReason?: string;

  /** Signals (kind=signal). */
  signal?: string;

  /** Crashes (kind=crash). */
  exitCode?: number | null;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
  errorCode?: string;

  /** Recovery attempts (kind=recover). */
  status?: "ok" | "error";
  detail?: string;
};

export type GatewayIncidentState = {
  version: 1;
  restartCount: number;
  lastStartAtMs?: number;
  lastRestartReason?: string;
  lastSignalAtMs?: number;
  lastSignal?: string;
  lastCrashAtMs?: number;
  lastCrashSummary?: string;
  lastRecoverAttemptAtMs?: number;
};

const INCIDENTS_FILENAME = "gateway-incidents.jsonl";
const STATE_FILENAME = "gateway-incidents-state.json";

export function resolveGatewayIncidentsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "state", INCIDENTS_FILENAME);
}

export function resolveGatewayIncidentStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "state", STATE_FILENAME);
}

function trimTail(input?: string | null, maxChars = 8000): string | undefined {
  if (!input) {
    return undefined;
  }
  const text = input.trimEnd();
  if (text.length <= maxChars) {
    return text;
  }
  return `…${text.slice(text.length - maxChars)}`;
}

function peekRestartReasonFromSentinelSync(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    const sentinelPath = resolveRestartSentinelPath(env);
    const raw = fs.readFileSync(sentinelPath, "utf-8");
    const parsed = JSON.parse(raw) as { payload?: { kind?: unknown } } | null;
    const kind = parsed?.payload?.kind;
    return typeof kind === "string" && kind.trim() ? kind.trim() : undefined;
  } catch {
    return undefined;
  }
}

const writesByPath = new Map<string, Promise<void>>();

async function pruneIfNeeded(filePath: string, opts: { maxBytes: number; keepLines: number }) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size <= opts.maxBytes) {
    return;
  }

  const raw = await fsp.readFile(filePath, "utf-8").catch(() => "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.slice(Math.max(0, lines.length - opts.keepLines));
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fsp.writeFile(tmp, `${kept.join("\n")}\n`, "utf-8");
  await fsp.rename(tmp, filePath);
}

export async function appendGatewayIncident(
  filePath: string,
  entry: GatewayIncidentEntry,
  opts?: { maxBytes?: number; keepLines?: number },
) {
  const resolved = path.resolve(filePath);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.appendFile(resolved, `${JSON.stringify(entry)}\n`, "utf-8");
      await pruneIfNeeded(resolved, {
        maxBytes: opts?.maxBytes ?? 2_000_000,
        keepLines: opts?.keepLines ?? 2_000,
      });
    });
  writesByPath.set(resolved, next);
  await next;
}

export function appendGatewayIncidentSync(filePath: string, entry: GatewayIncidentEntry) {
  try {
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // ignore
  }
}

export async function readGatewayIncidentState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayIncidentState> {
  const p = resolveGatewayIncidentStatePath(env);
  try {
    const raw = await fsp.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GatewayIncidentState> | null;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      throw new Error("invalid incident state");
    }
    const restartCount =
      typeof parsed.restartCount === "number" && Number.isFinite(parsed.restartCount)
        ? Math.max(0, Math.floor(parsed.restartCount))
        : 0;
    return {
      version: 1,
      restartCount,
      lastStartAtMs: typeof parsed.lastStartAtMs === "number" ? parsed.lastStartAtMs : undefined,
      lastRestartReason:
        typeof parsed.lastRestartReason === "string" ? parsed.lastRestartReason : undefined,
      lastSignalAtMs: typeof parsed.lastSignalAtMs === "number" ? parsed.lastSignalAtMs : undefined,
      lastSignal: typeof parsed.lastSignal === "string" ? parsed.lastSignal : undefined,
      lastCrashAtMs: typeof parsed.lastCrashAtMs === "number" ? parsed.lastCrashAtMs : undefined,
      lastCrashSummary:
        typeof parsed.lastCrashSummary === "string" ? parsed.lastCrashSummary : undefined,
      lastRecoverAttemptAtMs:
        typeof parsed.lastRecoverAttemptAtMs === "number"
          ? parsed.lastRecoverAttemptAtMs
          : undefined,
    };
  } catch {
    return { version: 1, restartCount: 0 };
  }
}

export async function writeGatewayIncidentState(
  state: GatewayIncidentState,
  env: NodeJS.ProcessEnv = process.env,
) {
  const p = resolveGatewayIncidentStatePath(env);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export async function readGatewayIncidentEntries(
  filePath: string,
  opts?: { limit?: number },
): Promise<GatewayIncidentEntry[]> {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 50)));
  const raw = await fsp.readFile(path.resolve(filePath), "utf-8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  const out: GatewayIncidentEntry[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Partial<GatewayIncidentEntry> | null;
      if (!obj || typeof obj !== "object") {
        continue;
      }
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
        continue;
      }
      if (
        obj.kind !== "start" &&
        obj.kind !== "signal" &&
        obj.kind !== "crash" &&
        obj.kind !== "recover"
      ) {
        continue;
      }
      out.push(obj as GatewayIncidentEntry);
    } catch {
      // ignore invalid lines
    }
  }
  return out.toReversed();
}

export async function recordGatewayStart(env: NodeJS.ProcessEnv = process.env) {
  const filePath = resolveGatewayIncidentsPath(env);
  const state = await readGatewayIncidentState(env);
  const restartCount = (state.restartCount ?? 0) + 1;
  const restartReason = peekRestartReasonFromSentinelSync(env);
  const now = Date.now();
  const nextState: GatewayIncidentState = {
    ...state,
    version: 1,
    restartCount,
    lastStartAtMs: now,
    lastRestartReason: restartReason,
  };
  await writeGatewayIncidentState(nextState, env);
  await appendGatewayIncident(filePath, {
    ts: now,
    kind: "start",
    pid: process.pid,
    restartCount,
    restartReason,
  });
  return nextState;
}

/**
 * Synchronous best-effort start recorder (used during fast shutdown paths).
 * Must never throw.
 */
export function recordGatewayStartSync(env: NodeJS.ProcessEnv = process.env) {
  try {
    const filePath = resolveGatewayIncidentsPath(env);
    const statePath = resolveGatewayIncidentStatePath(env);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    let state: GatewayIncidentState = { version: 1, restartCount: 0 };
    try {
      const raw = fs.readFileSync(statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GatewayIncidentState> | null;
      if (parsed && typeof parsed === "object" && parsed.version === 1) {
        const restartCount =
          typeof parsed.restartCount === "number" && Number.isFinite(parsed.restartCount)
            ? Math.max(0, Math.floor(parsed.restartCount))
            : 0;
        state = { ...state, ...parsed, restartCount };
      }
    } catch {
      // ignore
    }

    const now = Date.now();
    const restartCount = (state.restartCount ?? 0) + 1;
    const restartReason = peekRestartReasonFromSentinelSync(env);
    const nextState: GatewayIncidentState = {
      ...state,
      version: 1,
      restartCount,
      lastStartAtMs: now,
      lastRestartReason: restartReason,
    };

    fs.writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");
    appendGatewayIncidentSync(filePath, {
      ts: now,
      kind: "start",
      pid: process.pid,
      restartCount,
      restartReason,
    });

    return nextState;
  } catch {
    return null;
  }
}

export async function recordGatewaySignal(signal: string, env: NodeJS.ProcessEnv = process.env) {
  const filePath = resolveGatewayIncidentsPath(env);
  const state = await readGatewayIncidentState(env);
  const now = Date.now();
  const nextState: GatewayIncidentState = {
    ...state,
    version: 1,
    lastSignalAtMs: now,
    lastSignal: signal,
  };
  await writeGatewayIncidentState(nextState, env);
  await appendGatewayIncident(filePath, {
    ts: now,
    kind: "signal",
    pid: process.pid,
    restartCount: state.restartCount,
    signal,
  });
  return nextState;
}

/** Synchronous best-effort signal recorder (for fast shutdown paths). */
export function recordGatewaySignalSync(signal: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    const filePath = resolveGatewayIncidentsPath(env);
    const statePath = resolveGatewayIncidentStatePath(env);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    let state: GatewayIncidentState = { version: 1, restartCount: 0 };
    try {
      const raw = fs.readFileSync(statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GatewayIncidentState> | null;
      if (parsed && typeof parsed === "object" && parsed.version === 1) {
        const restartCount =
          typeof parsed.restartCount === "number" && Number.isFinite(parsed.restartCount)
            ? Math.max(0, Math.floor(parsed.restartCount))
            : 0;
        state = { ...state, ...parsed, restartCount };
      }
    } catch {
      // ignore
    }

    const now = Date.now();
    const nextState: GatewayIncidentState = {
      ...state,
      version: 1,
      lastSignalAtMs: now,
      lastSignal: signal,
    };

    fs.writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");
    appendGatewayIncidentSync(filePath, {
      ts: now,
      kind: "signal",
      pid: process.pid,
      restartCount: state.restartCount,
      signal,
    });

    return nextState;
  } catch {
    return null;
  }
}

export function recordGatewayCrashSync(params: {
  error: unknown;
  exitCode?: number | null;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const filePath = resolveGatewayIncidentsPath(env);
  const now = Date.now();
  const err = params.error;
  const errorName = err instanceof Error ? err.name : undefined;
  const errorMessage =
    err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  const errorStack = err instanceof Error ? err.stack : undefined;
  const errorCode =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : undefined;

  appendGatewayIncidentSync(filePath, {
    ts: now,
    kind: "crash",
    pid: process.pid,
    exitCode: params.exitCode ?? null,
    errorName,
    errorMessage: trimTail(errorMessage),
    errorStack: trimTail(errorStack),
    errorCode,
  });

  // Best-effort state update (sync).
  try {
    const statePath = resolveGatewayIncidentStatePath(env);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    let state: GatewayIncidentState = { version: 1, restartCount: 0 };
    try {
      const raw = fs.readFileSync(statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GatewayIncidentState> | null;
      if (parsed && typeof parsed === "object" && parsed.version === 1) {
        const restartCount =
          typeof parsed.restartCount === "number" && Number.isFinite(parsed.restartCount)
            ? Math.max(0, Math.floor(parsed.restartCount))
            : 0;
        state = { ...state, ...parsed, restartCount };
      }
    } catch {
      // ignore
    }
    const summary = `${errorName ?? "Error"}${errorMessage ? `: ${errorMessage}` : ""}`.trim();
    const nextState: GatewayIncidentState = {
      ...state,
      version: 1,
      lastCrashAtMs: now,
      lastCrashSummary: trimTail(summary, 512),
    };
    fs.writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");
  } catch {
    // ignore
  }
}

export async function recordGatewayRecoverAttempt(params: {
  status: "ok" | "error";
  detail?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const filePath = resolveGatewayIncidentsPath(env);
  const now = Date.now();
  const state = await readGatewayIncidentState(env);
  const nextState: GatewayIncidentState = {
    ...state,
    version: 1,
    lastRecoverAttemptAtMs: now,
  };
  await writeGatewayIncidentState(nextState, env);
  await appendGatewayIncident(filePath, {
    ts: now,
    kind: "recover",
    pid: process.pid,
    restartCount: state.restartCount,
    status: params.status,
    detail: params.detail ? trimTail(params.detail, 2000) : undefined,
  });
  return nextState;
}
