import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ExecHost } from "./exec-approvals.js";
import { analyzeShellCommand } from "./exec-approvals.js";
import { expandHomePrefix } from "./home-dir.js";

const log = createSubsystemLogger("exec/high-risk");

const WRAPPER_COMMANDS = new Set([
  "chpst",
  "command",
  "doas",
  "env",
  "ionice",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
]);

const WINDOWS_SUFFIX_RE = /\.(exe|cmd|bat|ps1)$/i;
const ENV_ASSIGNMENT_RE = /^[a-z_][a-z0-9_]*=/i;
const DEFAULT_HIGH_RISK_COMMANDS = ["rm", "mv", "cp", "dd", "format", "truncate"] as const;
const DEFAULT_AUDIT_LOG_PATH = "~/.openclaw/safety.log";

export type ExecHighRiskAuditMode = "full" | "minimal";

export type ExecHighRiskAuditConfig = {
  enabled?: boolean;
  file?: string;
  mode?: ExecHighRiskAuditMode;
};

export type ExecHighRiskSafetyConfig = {
  enabled?: boolean;
  commands?: string[];
  audit?: ExecHighRiskAuditConfig;
};

export type ResolvedExecHighRiskSafetyConfig = {
  enabled: boolean;
  commands: string[];
  audit: {
    enabled: boolean;
    file: string;
    mode: ExecHighRiskAuditMode;
  };
};

export type ExecHighRiskCommandMatch = {
  matchedCommands: string[];
};

export type ExecHighRiskAuditDecision = "approved" | "rejected";

export type ExecHighRiskAuditEntry = {
  safety: ResolvedExecHighRiskSafetyConfig;
  host: ExecHost;
  command: string;
  matchedCommands: string[];
  decision: ExecHighRiskAuditDecision;
  reason: string;
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

function normalizeCommandName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const base = path.basename(trimmed);
  const lowered = base.toLowerCase().replace(WINDOWS_SUFFIX_RE, "");
  return lowered || null;
}

function normalizeCommandList(values: ReadonlyArray<string> | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = normalizeCommandName(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function skipFlagTokens(argv: string[], index: number): number {
  let cursor = index;
  while (cursor < argv.length && argv[cursor]?.startsWith("-")) {
    cursor += 1;
  }
  return cursor;
}

function resolveSegmentCommandName(argv: string[]): string | null {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]?.trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(token)) {
      index += 1;
      continue;
    }
    const normalized = normalizeCommandName(token);
    if (!normalized) {
      return null;
    }
    if (!WRAPPER_COMMANDS.has(normalized)) {
      return normalized;
    }
    if (normalized === "env") {
      index += 1;
      while (index < argv.length) {
        const next = argv[index]?.trim() ?? "";
        if (!next) {
          index += 1;
          continue;
        }
        if (next.startsWith("-")) {
          index += 1;
          continue;
        }
        if (ENV_ASSIGNMENT_RE.test(next)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    index = skipFlagTokens(argv, index + 1);
  }
  return null;
}

function fallbackFirstToken(command: string): string | null {
  const first = command.trim().split(/\s+/)[0];
  return first ? normalizeCommandName(first) : null;
}

export function resolveExecHighRiskSafetyConfig(
  config?: ExecHighRiskSafetyConfig,
): ResolvedExecHighRiskSafetyConfig {
  const hasCustomCommands = Array.isArray(config?.commands);
  const commands = normalizeCommandList(config?.commands);
  const resolvedCommands = hasCustomCommands
    ? commands
    : [...DEFAULT_HIGH_RISK_COMMANDS].map((entry) => entry);
  return {
    enabled: config?.enabled === true,
    commands: resolvedCommands,
    audit: {
      enabled: config?.audit?.enabled !== false,
      file: config?.audit?.file?.trim() || DEFAULT_AUDIT_LOG_PATH,
      mode: config?.audit?.mode === "minimal" ? "minimal" : "full",
    },
  };
}

export function matchHighRiskExecCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  commands: string[];
}): ExecHighRiskCommandMatch | null {
  const configured = normalizeCommandList(params.commands);
  if (configured.length === 0) {
    return null;
  }
  const dangerous = new Set(configured);
  const matched = new Set<string>();
  const analysis = analyzeShellCommand({
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    platform: params.platform,
  });
  if (analysis.ok) {
    for (const segment of analysis.segments) {
      const name = resolveSegmentCommandName(segment.argv);
      if (name && dangerous.has(name)) {
        matched.add(name);
      }
    }
  } else {
    const fallback = fallbackFirstToken(params.command);
    if (fallback && dangerous.has(fallback)) {
      matched.add(fallback);
    }
  }
  if (matched.size === 0) {
    return null;
  }
  return { matchedCommands: [...matched] };
}

function renderLoggedCommand(params: {
  command: string;
  matchedCommands: string[];
  mode: ExecHighRiskAuditMode;
}): string {
  if (params.mode === "full") {
    return params.command;
  }
  return params.matchedCommands.join(" ");
}

export async function appendExecHighRiskAuditLog(entry: ExecHighRiskAuditEntry): Promise<void> {
  if (!entry.safety.enabled || !entry.safety.audit.enabled) {
    return;
  }
  const filePath = expandHomePrefix(entry.safety.audit.file);
  const payload = {
    timestamp: new Date().toISOString(),
    host: entry.host,
    decision: entry.decision,
    reason: entry.reason,
    command: renderLoggedCommand({
      command: entry.command,
      matchedCommands: entry.matchedCommands,
      mode: entry.safety.audit.mode,
    }),
    matchedCommands: entry.matchedCommands,
    agentId: entry.agentId ?? null,
    sessionKey: entry.sessionKey ?? null,
    source: {
      channel: entry.turnSourceChannel ?? null,
      to: entry.turnSourceTo ?? null,
      accountId: entry.turnSourceAccountId ?? null,
      threadId: entry.turnSourceThreadId ?? null,
    },
  };
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, { encoding: "utf-8" });
  } catch (err) {
    log.warn(`failed to append high-risk audit log: ${String(err)}`);
  }
}
