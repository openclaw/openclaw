import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExecAllowlistEntry,
  ExecApprovalsAgent,
  ExecAsk,
  ExecSecurity,
} from "./exec-approvals.js";

export function hashExecApprovalsRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

export function expandHome(value: string): string {
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

export function normalizeAllowlistPattern(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.toLowerCase() : null;
}

export function mergeLegacyAgent(
  current: ExecApprovalsAgent,
  legacy: ExecApprovalsAgent,
): ExecApprovalsAgent {
  const allowlist: ExecAllowlistEntry[] = [];
  const seen = new Set<string>();
  const pushEntry = (entry: ExecAllowlistEntry) => {
    const key = normalizeAllowlistPattern(entry.pattern);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    allowlist.push(entry);
  };
  for (const entry of current.allowlist ?? []) {
    pushEntry(entry);
  }
  for (const entry of legacy.allowlist ?? []) {
    pushEntry(entry);
  }

  return {
    security: current.security ?? legacy.security,
    ask: current.ask ?? legacy.ask,
    askFallback: current.askFallback ?? legacy.askFallback,
    autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
    allowlist: allowlist.length > 0 ? allowlist : undefined,
  };
}

export function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

// Coerce legacy/corrupted allowlists into `ExecAllowlistEntry[]` before we spread
// entries to add ids (spreading strings creates {"0":"l","1":"s",...}).
export function coerceAllowlistEntries(allowlist: unknown): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return Array.isArray(allowlist) ? (allowlist as ExecAllowlistEntry[]) : undefined;
  }
  let changed = false;
  const result: ExecAllowlistEntry[] = [];
  for (const item of allowlist) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        result.push({ pattern: trimmed });
        changed = true;
      } else {
        changed = true;
      }
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const pattern = (item as { pattern?: unknown }).pattern;
      if (typeof pattern === "string" && pattern.trim().length > 0) {
        result.push(item as ExecAllowlistEntry);
      } else {
        changed = true;
      }
    } else {
      changed = true;
    }
  }
  return changed ? (result.length > 0 ? result : undefined) : (allowlist as ExecAllowlistEntry[]);
}

export function ensureAllowlistIds(
  allowlist: ExecAllowlistEntry[] | undefined,
): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return allowlist;
  }
  let changed = false;
  const next = allowlist.map((entry) => {
    if (entry.id) {
      return entry;
    }
    changed = true;
    return { ...entry, id: crypto.randomUUID() };
  });
  return changed ? next : allowlist;
}

export function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function normalizeSecurity(
  value: ExecSecurity | undefined,
  fallback: ExecSecurity,
): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") {
    return value;
  }
  return fallback;
}

export function normalizeAsk(value: ExecAsk | undefined, fallback: ExecAsk): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") {
    return value;
  }
  return fallback;
}
