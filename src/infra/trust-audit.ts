import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "../logging/redact.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { expandHomePrefix } from "./home-dir.js";

export type TrustAuditEntry = {
  ts: number;
  cmd: string;
  code: number | null;
  durationMs?: number | null;
};

const MAX_COMMAND_CHARS = 200;

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeAgentId(agentId?: string): string {
  const trimmed = agentId?.trim();
  return trimmed ? trimmed.toLowerCase() : DEFAULT_AGENT_ID;
}

export function resolveTrustAuditPath(agentId?: string): string {
  return expandHomePrefix(`~/.openclaw/trust-audit-${normalizeAgentId(agentId)}.jsonl`);
}

function truncateCommand(value: string): string {
  if (value.length <= MAX_COMMAND_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

export function formatTrustAuditCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return truncateCommand(redactSensitiveText(normalized));
}

export function appendTrustAuditEntry(params: {
  agentId?: string;
  command: string;
  exitCode?: number | null;
  durationMs?: number | null;
  now?: number;
}): TrustAuditEntry | null {
  const trimmed = params.command.trim();
  if (!trimmed) {
    return null;
  }

  const entry: TrustAuditEntry = {
    ts: typeof params.now === "number" ? params.now : Date.now(),
    cmd: formatTrustAuditCommand(trimmed),
    code: typeof params.exitCode === "number" ? params.exitCode : null,
    durationMs: typeof params.durationMs === "number" ? params.durationMs : null,
  };

  const filePath = resolveTrustAuditPath(params.agentId);
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms without chmod support.
  }
  return entry;
}

export function loadTrustAudit(params?: { agentId?: string }): {
  entries: TrustAuditEntry[];
  exists: boolean;
} {
  const filePath = resolveTrustAuditPath(params?.agentId);
  if (!fs.existsSync(filePath)) {
    return { entries: [], exists: false };
  }
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: TrustAuditEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as TrustAuditEntry;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      if (typeof parsed.ts !== "number" || typeof parsed.cmd !== "string") {
        continue;
      }
      entries.push({
        ts: parsed.ts,
        cmd: parsed.cmd,
        code: typeof parsed.code === "number" ? parsed.code : null,
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : null,
      });
    } catch {
      // Ignore malformed audit lines.
    }
  }
  return { entries, exists: true };
}

function formatDuration(durationMs: number): string {
  const minutes = Math.max(0, Math.ceil(durationMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function resolveDurationMs(params: {
  entries: TrustAuditEntry[];
  startedAt?: number;
  endedAt?: number;
}): number | null {
  const { entries, startedAt, endedAt } = params;
  const start = typeof startedAt === "number" ? startedAt : entries[0]?.ts;
  const end =
    typeof endedAt === "number"
      ? endedAt
      : entries.length > 0
        ? entries[entries.length - 1]?.ts
        : start;
  if (typeof start !== "number" || typeof end !== "number") {
    return null;
  }
  return Math.max(0, end - start);
}

export function summarizeTrustAudit(params: {
  agentId?: string;
  startedAt?: number;
  endedAt?: number;
}): string | null {
  const { entries: allEntries } = loadTrustAudit({ agentId: params.agentId });
  const entries =
    typeof params.startedAt === "number" || typeof params.endedAt === "number"
      ? allEntries.filter((entry) => {
          if (typeof params.startedAt === "number" && entry.ts < params.startedAt) {
            return false;
          }
          if (typeof params.endedAt === "number" && entry.ts > params.endedAt) {
            return false;
          }
          return true;
        })
      : allEntries;

  if (entries.length === 0) {
    return null;
  }

  const failedCount = entries.filter(
    (entry) => typeof entry.code === "number" && entry.code !== 0,
  ).length;
  const durationMs = resolveDurationMs({
    entries,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
  });
  const lines: string[] = [
    "📋 Trust window summary",
    `Duration: ${durationMs === null ? "unknown" : formatDuration(durationMs)} · Commands: ${entries.length} (${failedCount} failed)`,
  ];

  const commands = entries.map((entry) => entry.cmd).filter(Boolean);
  if (commands.length > 0) {
    lines.push("");
    const previewLimit = 5;
    if (commands.length <= 10) {
      for (const command of commands) {
        lines.push(`- ${command}`);
      }
    } else {
      for (const command of commands.slice(0, previewLimit)) {
        lines.push(`- ${command}`);
      }
      lines.push(`- …and ${commands.length - previewLimit} more`);
    }
  }

  return lines.join("\n");
}

export function cleanupTrustAudit(agentId?: string): void {
  const filePath = resolveTrustAuditPath(agentId);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}
