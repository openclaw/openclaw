import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type HitlAllowlistEntry = {
  id: string;
  pattern: string;
  createdAt: number;
  lastUsedAt?: number;
};

export type HitlAllowlistFile = {
  version: 1;
  entries: HitlAllowlistEntry[];
};

const DEFAULT_FILE = "~/.openclaw/hitl-approvals.json";

function expandHome(value: string): string {
  if (!value) {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveHitlAllowlistPath(): string {
  return expandHome(DEFAULT_FILE);
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function normalizePattern(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i += 1;
        continue;
      }
      regex += "[^:]*";
      continue;
    }
    if (ch === "?") {
      regex += ".";
      continue;
    }
    regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex, "i");
}

export function matchesHitlAllowlist(patterns: string[], key: string): boolean {
  const target = key.toLowerCase();
  return patterns.some((raw) => {
    const pattern = normalizePattern(raw);
    if (!pattern) {
      return false;
    }
    try {
      return globToRegExp(pattern).test(target);
    } catch {
      return target.includes(pattern);
    }
  });
}

export function loadHitlAllowlist(): HitlAllowlistFile {
  const filePath = resolveHitlAllowlistPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, entries: [] };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, entries: [] };
    }
    const version = (parsed as { version?: unknown }).version;
    const entries = (parsed as { entries?: unknown }).entries;
    if (version !== 1 || !Array.isArray(entries)) {
      return { version: 1, entries: [] };
    }
    const normalized: HitlAllowlistEntry[] = entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const pattern = normalizePattern((entry as { pattern?: unknown }).pattern as string);
        if (!pattern) {
          return null;
        }
        const id =
          typeof (entry as { id?: unknown }).id === "string" && (entry as { id?: unknown }).id
            ? ((entry as { id?: unknown }).id as string)
            : crypto.randomUUID();
        const createdAt =
          typeof (entry as { createdAt?: unknown }).createdAt === "number"
            ? ((entry as { createdAt?: unknown }).createdAt as number)
            : Date.now();
        const lastUsedAt =
          typeof (entry as { lastUsedAt?: unknown }).lastUsedAt === "number"
            ? ((entry as { lastUsedAt?: unknown }).lastUsedAt as number)
            : undefined;
        return { id, pattern, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}) };
      })
      .filter(Boolean) as HitlAllowlistEntry[];
    return { version: 1, entries: normalized };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function saveHitlAllowlist(file: HitlAllowlistFile) {
  const filePath = resolveHitlAllowlistPath();
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export function addHitlAllowlistEntry(pattern: string) {
  const normalized = normalizePattern(pattern);
  if (!normalized) {
    return;
  }
  const file = loadHitlAllowlist();
  if (file.entries.some((entry) => entry.pattern === normalized)) {
    return;
  }
  file.entries.push({ id: crypto.randomUUID(), pattern: normalized, createdAt: Date.now() });
  saveHitlAllowlist(file);
}
