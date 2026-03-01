import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export const USER_ARCHIVE_SHUTDOWN_REASON = "user-archive";

type GatewayShutdownState = {
  reason: string;
  at: number;
};

const SHUTDOWN_STATE_FILE = "gateway-last-shutdown.json";
let pendingStopReason: string | null = null;
let pendingStopTimer: ReturnType<typeof setTimeout> | null = null;

function resolveShutdownStatePath(): string {
  return path.join(resolveStateDir(process.env), SHUTDOWN_STATE_FILE);
}

function normalizeReason(reason?: string): string {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.slice(0, 200) : "gateway stopping";
}

function emitSigint(): void {
  if (process.listenerCount("SIGINT") > 0) {
    process.emit("SIGINT");
    return;
  }
  process.kill(process.pid, "SIGINT");
}

export function requestGatewayStop(params?: { reason?: string; delayMs?: number }): {
  ok: boolean;
  reason: string;
  delayMs: number;
} {
  const reason = normalizeReason(params?.reason);
  const delayMs =
    typeof params?.delayMs === "number" && Number.isFinite(params.delayMs)
      ? Math.max(0, Math.floor(params.delayMs))
      : 0;
  pendingStopReason = reason;
  if (pendingStopTimer) {
    clearTimeout(pendingStopTimer);
    pendingStopTimer = null;
  }
  if (delayMs === 0) {
    emitSigint();
    return { ok: true, reason, delayMs };
  }
  pendingStopTimer = setTimeout(() => {
    pendingStopTimer = null;
    emitSigint();
  }, delayMs);
  return { ok: true, reason, delayMs };
}

export function consumeRequestedGatewayStopReason(fallbackReason: string): string {
  const reason = normalizeReason(pendingStopReason ?? fallbackReason);
  pendingStopReason = null;
  return reason;
}

export async function persistGatewayShutdownState(params: {
  reason?: string;
  at?: number;
}): Promise<void> {
  const state: GatewayShutdownState = {
    reason: normalizeReason(params.reason),
    at:
      typeof params.at === "number" && Number.isFinite(params.at)
        ? Math.max(0, Math.floor(params.at))
        : Date.now(),
  };
  const filePath = resolveShutdownStatePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state)}\n`, "utf-8");
}

export async function consumeGatewayShutdownState(): Promise<GatewayShutdownState | null> {
  const filePath = resolveShutdownStatePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Best-effort: keep startup path resilient even if cleanup fails.
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GatewayShutdownState>;
    const reason = normalizeReason(parsed.reason);
    const at =
      typeof parsed.at === "number" && Number.isFinite(parsed.at)
        ? Math.max(0, Math.floor(parsed.at))
        : 0;
    return { reason, at };
  } catch {
    return null;
  }
}

export const __testing = {
  resetPendingStopReason() {
    pendingStopReason = null;
    if (pendingStopTimer) {
      clearTimeout(pendingStopTimer);
      pendingStopTimer = null;
    }
  },
};
