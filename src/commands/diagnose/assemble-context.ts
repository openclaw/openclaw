import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { resolveStateDir } from "../../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";

export interface DiagnosticContext {
  /** Combined Markdown text of all context sections. */
  text: string;
  /** Number of WARN/ERROR/FATAL log entries included. */
  logEntryCount: number;
  /** Number of auth rejection events found. */
  authRejectCount: number;
  /** Installed OpenClaw version string, or null. */
  version: string | null;
}

interface AssembleOptions {
  maxLogEntries: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const RE_ANSI = /\x1b\[[0-9;]*[mGKHF]/g;
const RE_IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
// Suffix-based matching catches botToken, appToken, webhookSecret, accessToken,
// apiKey, etc. — not just exact key names.
const SECRET_SUFFIXES = ["token", "secret", "password", "apikey", "api_key", "authorization"];

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(suffix));
}

function stripAnsi(text: string): string {
  return text.replace(RE_ANSI, "");
}

function redactSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 10) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecrets(item, depth + 1));
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSecretKey(key) && typeof value === "string" && value.length > 0) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSecrets(value, depth + 1);
      }
    }
    return result;
  }
  return obj;
}

function resolveLogDir(): string {
  return resolvePreferredOpenClawTmpDir();
}

function todayLogFileName(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `openclaw-${year}-${month}-${day}.log`;
}

interface ParsedLogEntry {
  timestamp: string;
  level: string;
  subsystem: string;
  message: string;
  raw: string;
}

// OpenClaw gateway logs are JSON lines. Each line is a JSON object with:
//   "0": subsystem info (JSON string like '{"subsystem":"gateway/ws"}')
//   "1": message text
//   "_meta": { "logLevelName": "INFO"|"WARN"|"ERROR"|"FATAL", "date": "..." }
//   "time": local ISO timestamp
// Fallback regex handles any non-JSON log lines (older versions, plain text).
const RE_LOG_LINE_FALLBACK =
  /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)?)\s+\[(\w+)]\s+\[([^\]]*?)]\s+(.*)/;

function parseLogLine(line: string): ParsedLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Try JSON parse first (primary format).
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      const meta = obj._meta ?? {};
      const level = meta.logLevelName ?? "";
      const timestamp = obj.time ?? meta.date ?? "";
      let subsystem = "";
      try {
        const sub = JSON.parse(obj["0"] ?? "{}");
        subsystem = sub.subsystem ?? "";
      } catch {
        subsystem = String(obj["0"] ?? "");
      }
      const message = String(obj["1"] ?? "");
      if (!level && !message) return null;
      return { timestamp, level, subsystem, message, raw: trimmed };
    } catch {
      // Fall through to regex.
    }
  }

  // Fallback: plain-text log format.
  const match = RE_LOG_LINE_FALLBACK.exec(trimmed);
  if (!match) return null;
  return {
    timestamp: match[1],
    level: match[2],
    subsystem: match[3],
    message: match[4],
    raw: trimmed,
  };
}

// ── Section assemblers ───────────────────────────────────────────────────

function assembleGatewayLog(maxEntries: number): {
  section: string;
  entryCount: number;
  allParsed: ParsedLogEntry[];
} {
  const logDir = resolveLogDir();
  const datedPath = path.join(logDir, todayLogFileName());
  const fallbackPath = path.join(logDir, "openclaw.log");
  const datedExists = fs.existsSync(datedPath);
  const fallbackExists = fs.existsSync(fallbackPath);

  if (!datedExists && !fallbackExists) {
    return {
      section: "## Gateway Log\nLog file not found — gateway may not have run today.\n",
      entryCount: 0,
      allParsed: [],
    };
  }

  const actualPath = datedExists ? datedPath : fallbackPath;

  try {
    const content = fs.readFileSync(actualPath, { encoding: "utf-8" });
    const lines = content.split("\n");
    const totalLines = lines.length;
    const allParsed: ParsedLogEntry[] = [];
    const issueEntries: ParsedLogEntry[] = [];

    for (const line of lines) {
      const entry = parseLogLine(line);
      if (!entry) continue;
      allParsed.push(entry);
      if (["WARN", "WARNING", "ERROR", "FATAL"].includes(entry.level)) {
        issueEntries.push(entry);
      }
    }

    const totalIssues = issueEntries.length;
    const shown = issueEntries.slice(-maxEntries);
    let section = `## Gateway Log (${todayLogFileName()}) — WARN/ERROR/FATAL entries\n`;
    section += `Total log lines: ${totalLines}. Total issues: ${totalIssues}.`;
    if (totalIssues > shown.length) {
      section += ` Showing most recent ${shown.length} (truncated to fit token limit).`;
    }
    section += "\n\n";

    if (shown.length > 0) {
      for (const entry of shown) {
        section += `[${entry.timestamp}] [${entry.level}] [${entry.subsystem}] ${entry.message}\n`;
      }
    } else {
      section += "(No WARN/ERROR/FATAL entries found — gateway log appears clean.)\n";
    }

    return { section, entryCount: shown.length, allParsed };
  } catch (err) {
    return {
      section: `## Gateway Log\nError reading log file: ${String(err)}\n`,
      entryCount: 0,
      allParsed: [],
    };
  }
}

function assembleRedactedConfig(): string {
  const stateDir = resolveStateDir();
  const configPath = path.join(stateDir, "openclaw.json");

  if (!fs.existsSync(configPath)) {
    return "## OpenClaw Configuration\nopenclaw.json not found.\n";
  }

  try {
    const raw = fs.readFileSync(configPath, { encoding: "utf-8" });
    const parsed = JSON5.parse(raw);
    const redacted = redactSecrets(parsed);
    return (
      "## OpenClaw Configuration (openclaw.json, secrets redacted)\n" +
      JSON.stringify(redacted, null, 2) +
      "\n"
    );
  } catch (err) {
    return `## OpenClaw Configuration\nError reading openclaw.json: ${String(err)}\n`;
  }
}

function assembleHealthData(): string {
  const stateDir = resolveStateDir();
  const healthPath = path.join(stateDir, "workspace", "memory", "health.json");

  if (!fs.existsSync(healthPath)) {
    return "## Watchdog Health Data\nhealth.json not found — watchdog may not have run.\n";
  }

  try {
    const raw = fs.readFileSync(healthPath, { encoding: "utf-8" });
    return "## Watchdog Health Data (health.json)\n" + raw + "\n";
  } catch (err) {
    return `## Watchdog Health Data\nError reading health.json: ${String(err)}\n`;
  }
}

async function assembleVersionInfo(): Promise<{ section: string; version: string | null }> {
  try {
    const result = await runCommandWithTimeout(["openclaw", "--version"], {
      timeoutMs: 15_000,
    });
    const version = stripAnsi(result.stdout).trim() || null;
    return {
      section: `## OpenClaw Version\n${version ?? "Unknown"}\n`,
      version,
    };
  } catch (err) {
    return {
      section: `## OpenClaw Version\nError: ${String(err)}\n`,
      version: null,
    };
  }
}

function assembleAuthSummary(allParsed: ParsedLogEntry[]): {
  section: string;
  count: number;
} {
  const rejects = allParsed.filter((entry) => {
    const sub = (entry.subsystem || "").toLowerCase();
    const msg = (entry.message || "").toLowerCase();
    return (
      sub.includes("auth") &&
      (msg.includes("rejected") ||
        msg.includes("denied") ||
        msg.includes("invalid token") ||
        msg.includes("unauthorized"))
    );
  });

  const sourceIps = new Set<string>();
  for (const entry of rejects) {
    const match = RE_IP.exec(entry.message);
    if (match) sourceIps.add(match[0]);
  }

  let section = "## Security Events — Auth Rejections\n";
  if (rejects.length === 0) {
    section += "No auth rejection events found in today's log.\n";
  } else {
    section += `${rejects.length} auth rejection event(s) detected.`;
    if (rejects.length >= 2) {
      section += ` First: ${rejects[0].timestamp}, Last: ${rejects[rejects.length - 1].timestamp}.`;
    }
    section += "\n";
    if (sourceIps.size > 0) {
      section += `Source IPs: ${[...sourceIps].sort().join(", ")}\n`;
    }
  }

  return { section, count: rejects.length };
}

function assembleSystemMemory(): string {
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const usedMb = totalMb - freeMb;
  const pctUsed = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;

  return (
    "## System Memory (at time of diagnostic run)\n" +
    `Total: ${totalMb} MB, Used: ${usedMb} MB (${pctUsed}%), Free: ${freeMb} MB\n` +
    `Platform: ${os.platform()} ${os.arch()}, Node: ${process.versions.node}\n`
  );
}

// ── Main assembler ───────────────────────────────────────────────────────

export async function assembleDiagnosticContext(
  opts: AssembleOptions,
): Promise<DiagnosticContext> {
  const logResult = assembleGatewayLog(opts.maxLogEntries);
  const configSection = assembleRedactedConfig();
  const healthSection = assembleHealthData();
  const versionResult = await assembleVersionInfo();
  const authResult = assembleAuthSummary(logResult.allParsed);
  const memorySection = assembleSystemMemory();

  const text = [
    logResult.section,
    configSection,
    healthSection,
    versionResult.section,
    authResult.section,
    memorySection,
  ].join("\n\n");

  return {
    text,
    logEntryCount: logResult.entryCount,
    authRejectCount: authResult.count,
    version: versionResult.version,
  };
}
