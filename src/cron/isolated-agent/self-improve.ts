import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { truncateUtf16Safe } from "../../utils.js";

type Finding = {
  sessionId: string;
  timestamp?: string;
  userText: string;
  assistantText?: string;
};

const SELF_IMPROVE_TRIGGER_RE =
  /\b(self[\s-]*improv(?:e|ement)?|self[\s-]*heal(?:ing)?|autofix|bot[\s-]*hardening|triage[\s-]*hardening)\b/i;
const FAILURE_SIGNAL_RE =
  /\b(i don['’]t have|cannot|can['’]t|unable|failed|failure|error|missing_scope|provider_unavailable|not found|permission denied|authentication failed|timeout)\b/i;
const IMPROVEMENT_SIGNAL_RE =
  /\b(should|could you|can you|please|feature|improve|improvement|enhance|support|add|new)\b/i;

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_FAILURES = 12;
const DEFAULT_MAX_IMPROVEMENTS = 12;
const SUMMARY_LINE_MAX_CHARS = 220;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeOneLine(text: string, limit = SUMMARY_LINE_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}...` : clean;
}

function extractTimestamp(
  entry: Record<string, unknown>,
  message?: Record<string, unknown>,
): string | undefined {
  const entryTs = entry.timestamp;
  if (typeof entryTs === "string" && entryTs.trim()) {
    return entryTs.trim();
  }
  const messageTs = message?.timestamp;
  if (typeof messageTs === "number" && Number.isFinite(messageTs)) {
    return new Date(messageTs).toISOString();
  }
  if (typeof messageTs === "string" && messageTs.trim()) {
    return messageTs.trim();
  }
  return undefined;
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const line = normalizeOneLine(content, 1000);
    return line || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const lines: string[] = [];
  for (const item of content) {
    const record = toRecord(item);
    if (!record) {
      continue;
    }
    if (record.type !== "text") {
      continue;
    }
    const text = record.text;
    if (typeof text !== "string") {
      continue;
    }
    const line = normalizeOneLine(text, 1000);
    if (line) {
      lines.push(line);
    }
  }
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join(" ");
}

function extractTurn(entry: Record<string, unknown>): {
  role?: "user" | "assistant";
  timestamp?: string;
  text?: string;
} {
  const message = toRecord(entry.message);
  if (!message) {
    return {};
  }
  const roleRaw = message.role;
  const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : undefined;
  if (!role) {
    return {};
  }
  const text = extractTextFromContent(message.content);
  return {
    role,
    timestamp: extractTimestamp(entry, message),
    text,
  };
}

async function listRecentTranscriptFiles(params: {
  sessionsDir: string;
  maxSessions: number;
}): Promise<string[]> {
  const entries = await fsp.readdir(params.sessionsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(params.sessionsDir, entry.name));
  if (files.length === 0) {
    return [];
  }

  const stats = await Promise.all(
    files.map(async (filePath) => {
      try {
        const stat = await fsp.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      } catch {
        return { filePath, mtimeMs: 0 };
      }
    }),
  );

  return stats
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, params.maxSessions))
    .map((entry) => entry.filePath);
}

async function collectFindingsFromTranscript(params: {
  filePath: string;
}): Promise<{ failures: Finding[]; improvements: Finding[] }> {
  const failures: Finding[] = [];
  const improvements: Finding[] = [];
  const sessionId = path.basename(params.filePath, ".jsonl");
  const stream = fs.createReadStream(params.filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lastUser: { text: string; timestamp?: string } | undefined;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const entry = toRecord(parsed);
      if (!entry) {
        continue;
      }
      const turn = extractTurn(entry);
      if (!turn.role || !turn.text) {
        continue;
      }

      if (turn.role === "user") {
        lastUser = { text: turn.text, timestamp: turn.timestamp };
        if (IMPROVEMENT_SIGNAL_RE.test(turn.text)) {
          improvements.push({
            sessionId,
            timestamp: turn.timestamp,
            userText: turn.text,
          });
        }
        continue;
      }

      if (!lastUser) {
        continue;
      }
      if (!FAILURE_SIGNAL_RE.test(turn.text)) {
        continue;
      }
      failures.push({
        sessionId,
        timestamp: turn.timestamp ?? lastUser.timestamp,
        userText: lastUser.text,
        assistantText: turn.text,
      });
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { failures, improvements };
}

function dedupeFindings(findings: Finding[], withAssistant: boolean): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of findings) {
    const key = withAssistant
      ? `${finding.sessionId}|${normalizeOneLine(finding.userText, 180)}|${normalizeOneLine(finding.assistantText ?? "", 180)}`
      : `${finding.sessionId}|${normalizeOneLine(finding.userText, 180)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function formatFailure(finding: Finding): string {
  const user = normalizeOneLine(finding.userText);
  const assistant = normalizeOneLine(finding.assistantText ?? "");
  const ts = finding.timestamp ? ` @ ${finding.timestamp}` : "";
  return `- [${finding.sessionId}${ts}] user: "${user}" | assistant: "${assistant}"`;
}

function formatImprovement(finding: Finding): string {
  const user = normalizeOneLine(finding.userText);
  const ts = finding.timestamp ? ` @ ${finding.timestamp}` : "";
  return `- [${finding.sessionId}${ts}] request: "${user}"`;
}

export function isSelfImproveCronRun(params: {
  jobId?: string;
  jobName?: string;
  message?: string;
}): boolean {
  const haystack = `${params.jobId ?? ""}\n${params.jobName ?? ""}\n${params.message ?? ""}`;
  return SELF_IMPROVE_TRIGGER_RE.test(haystack);
}

export async function buildSelfImproveConversationHistorySummary(params: {
  agentId: string;
  sessionsDir?: string;
  maxSessions?: number;
  maxFailures?: number;
  maxImprovements?: number;
}): Promise<string | undefined> {
  const sessionsDir = params.sessionsDir ?? resolveSessionTranscriptsDirForAgent(params.agentId);
  const maxSessions = params.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxFailures = params.maxFailures ?? DEFAULT_MAX_FAILURES;
  const maxImprovements = params.maxImprovements ?? DEFAULT_MAX_IMPROVEMENTS;

  let files: string[];
  try {
    files = await listRecentTranscriptFiles({ sessionsDir, maxSessions });
  } catch {
    return undefined;
  }
  if (files.length === 0) {
    return undefined;
  }

  const failureFindings: Finding[] = [];
  const improvementFindings: Finding[] = [];
  for (const filePath of files) {
    const findings = await collectFindingsFromTranscript({ filePath });
    failureFindings.push(...findings.failures);
    improvementFindings.push(...findings.improvements);
    if (failureFindings.length >= maxFailures && improvementFindings.length >= maxImprovements) {
      break;
    }
  }

  const failures = dedupeFindings(failureFindings, true).slice(0, Math.max(0, maxFailures));
  const improvements = dedupeFindings(improvementFindings, false).slice(
    0,
    Math.max(0, maxImprovements),
  );

  if (failures.length === 0 && improvements.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  lines.push("Conversation history signals (recent sessions):");
  if (failures.length > 0) {
    lines.push("Potential failures:");
    lines.push(...failures.map(formatFailure));
  } else {
    lines.push("Potential failures: none found in sampled sessions.");
  }
  if (improvements.length > 0) {
    lines.push("Potential improvements/new features:");
    lines.push(...improvements.map(formatImprovement));
  } else {
    lines.push("Potential improvements/new features: none found in sampled sessions.");
  }
  return lines.join("\n");
}

export function buildSelfImproveRunbookText(params: {
  agentId: string;
  historySummary?: string;
}): string {
  const lines: string[] = [];
  lines.push("Self-improvement runbook:");
  lines.push(
    `- Review conversation history from session logs under ~/.openclaw/agents/${params.agentId}/sessions/*.jsonl (or use the session-logs skill).`,
  );
  lines.push(
    "- Identify concrete failures that blocked correct replies, then implement code/config fixes and open PRs.",
  );
  lines.push(
    "- Also identify improvement/new-feature asks from user requests, implement them when feasible, and open PRs.",
  );
  lines.push(
    "- For each PR, include evidence from conversation history that motivated the change.",
  );
  if (params.historySummary?.trim()) {
    lines.push("");
    lines.push(params.historySummary.trim());
  }
  return lines.join("\n");
}
