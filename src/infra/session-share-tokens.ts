import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { generateSecureHex } from "./secure-random.js";

export type SessionShareToken = {
  token: string;
  sessionKey: string;
  expiresAtMs: number;
  createdAtMs: number;
  createdByDeviceId: string;
};

const SESSION_SHARE_TOKENS_FILE = "session-share-tokens.jsonl";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_BYTES = 32;

// In-memory store keyed by token string.
const tokenStore = new Map<string, SessionShareToken>();

let persistencePath: string | undefined;

export function initSessionShareTokens(params?: { stateDir?: string }): void {
  const dir = params?.stateDir ?? resolveStateDir();
  persistencePath = path.join(dir, SESSION_SHARE_TOKENS_FILE);
  loadFromDisk();
}

function loadFromDisk(): void {
  if (!persistencePath) {
    return;
  }
  try {
    if (!fs.existsSync(persistencePath)) {
      return;
    }
    const lines = fs.readFileSync(persistencePath, "utf8").split("\n");
    const nowMs = Date.now();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const entry: unknown = JSON.parse(trimmed);
        if (!isValidTokenEntry(entry)) {
          continue;
        }
        if (entry.expiresAtMs > nowMs) {
          tokenStore.set(entry.token, entry);
        }
      } catch {
        // Skip malformed lines.
      }
    }
  } catch {
    // Best-effort load.
  }
}

function isValidTokenEntry(entry: unknown): entry is SessionShareToken {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const e = entry as Record<string, unknown>;
  return (
    typeof e.token === "string" &&
    e.token.length > 0 &&
    typeof e.sessionKey === "string" &&
    e.sessionKey.length > 0 &&
    typeof e.expiresAtMs === "number" &&
    typeof e.createdAtMs === "number" &&
    typeof e.createdByDeviceId === "string"
  );
}

function appendToDisk(entry: SessionShareToken): void {
  if (!persistencePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(persistencePath), { recursive: true });
    fs.appendFileSync(persistencePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort persistence.
  }
}

function rewriteDisk(): void {
  if (!persistencePath) {
    return;
  }
  try {
    const nowMs = Date.now();
    const lines: string[] = [];
    for (const entry of tokenStore.values()) {
      if (entry.expiresAtMs > nowMs) {
        lines.push(JSON.stringify(entry));
      }
    }
    fs.mkdirSync(path.dirname(persistencePath), { recursive: true });
    fs.writeFileSync(persistencePath, lines.length > 0 ? `${lines.join("\n")}\n` : "", {
      mode: 0o600,
    });
  } catch {
    // Best-effort rewrite.
  }
}

export function clampTtlMs(ttlMs: number | undefined): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(ttlMs, MAX_TTL_MS);
}

export function createSessionShareToken(params: {
  sessionKey: string;
  ttlMs?: number;
  createdByDeviceId: string;
}): SessionShareToken {
  const nowMs = Date.now();
  const ttl = clampTtlMs(params.ttlMs);
  const entry: SessionShareToken = {
    token: generateSecureHex(TOKEN_BYTES),
    sessionKey: params.sessionKey,
    expiresAtMs: nowMs + ttl,
    createdAtMs: nowMs,
    createdByDeviceId: params.createdByDeviceId,
  };
  tokenStore.set(entry.token, entry);
  appendToDisk(entry);
  return entry;
}

export function resolveSessionShareToken(token: string): { sessionKey: string } | null {
  const entry = tokenStore.get(token);
  if (!entry) {
    return null;
  }
  if (entry.expiresAtMs <= Date.now()) {
    tokenStore.delete(token);
    return null;
  }
  return { sessionKey: entry.sessionKey };
}

export function revokeSessionShareToken(token: string): boolean {
  const existed = tokenStore.has(token);
  if (existed) {
    tokenStore.delete(token);
    rewriteDisk();
  }
  return existed;
}

export function pruneExpiredTokens(): number {
  const nowMs = Date.now();
  let pruned = 0;
  for (const [token, entry] of tokenStore.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      tokenStore.delete(token);
      pruned++;
    }
  }
  if (pruned > 0) {
    rewriteDisk();
  }
  return pruned;
}

export { DEFAULT_TTL_MS, MAX_TTL_MS };
