import fs from "node:fs/promises";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export async function readFileTailLines(filePath: string, maxLines: number): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  const lines = raw.replace(/\r/g, "").split("\n");
  const out = lines.slice(Math.max(0, lines.length - maxLines));
  return out.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

function countMatches(haystack: string, needle: string): number {
  if (!haystack || !needle) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function formatDurationSeconds(msText: string | null | undefined): string {
  const ms = Number(msText);
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function shorten(message: string, maxLen: number): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxLen - 1))}…`;
}

function normalizeGwsLine(line: string): string {
  return line
    .replace(/\s+runId=[^\s]+/g, "")
    .replace(/\s+conn=[^\s]+/g, "")
    .replace(/\s+id=[^\s]+/g, "")
    .replace(/\s+error=Error:.*$/g, "")
    .trim();
}

function splitTimestampPrefix(line: string): { hasTimestampPrefix: boolean; content: string } {
  const match = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+(.*)$/);
  if (!match) {
    return { hasTimestampPrefix: false, content: line.trimStart() };
  }
  return { hasTimestampPrefix: true, content: (match[1] ?? "").trimStart() };
}

function shouldSkipLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }

  const { hasTimestampPrefix, content } = splitTimestampPrefix(trimmed);
  const normalized = normalizeLowercaseStringOrEmpty(content || trimmed);

  if (
    normalized.includes("begin external-content") ||
    normalized.includes("end external-content") ||
    normalized === "source: web fetch" ||
    normalized === "404: not found"
  ) {
    return true;
  }

  if (hasTimestampPrefix && !content.startsWith("[")) {
    return true;
  }

  if (
    (normalized.startsWith("[ws]") && normalized.includes("⇄ res ✓")) ||
    normalized.startsWith("[feishu] received message") ||
    normalized.startsWith("[feishu] dispatch message") ||
    normalized.startsWith("[feishu] stream start") ||
    normalized.startsWith("[feishu] stream close") ||
    normalized.startsWith("[exec] elevated command") ||
    normalized.startsWith("[tools] read failed") ||
    normalized.startsWith("[tools] web_fetch failed")
  ) {
    return true;
  }

  return false;
}

function consumeJsonBlock(
  lines: string[],
  startIndex: number,
): { json: string; endIndex: number } | null {
  const startLine = lines[startIndex] ?? "";
  const braceAt = startLine.indexOf("{");
  if (braceAt < 0) {
    return null;
  }

  const parts: string[] = [startLine.slice(braceAt)];
  let depth = countMatches(parts[0] ?? "", "{") - countMatches(parts[0] ?? "", "}");
  let i = startIndex;
  while (depth > 0 && i + 1 < lines.length) {
    i += 1;
    const next = lines[i] ?? "";
    parts.push(next);
    depth += countMatches(next, "{") - countMatches(next, "}");
  }
  return { json: parts.join("\n"), endIndex: i };
}

export function summarizeLogTail(rawLines: string[], opts?: { maxLines?: number }): string[] {
  const maxLines = Math.max(6, opts?.maxLines ?? 26);

  const out: string[] = [];
  const groups = new Map<string, { count: number; index: number; base: string }>();

  const addGroup = (key: string, base: string) => {
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    groups.set(key, { count: 1, index: out.length, base });
    out.push(base);
  };

  const addLine = (line: string) => {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      return;
    }
    out.push(trimmed);
  };

  const lines = rawLines.map((line) => line.trimEnd()).filter(Boolean);
  let skipIndentedResidue = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmedStart = line.trimStart();
    const { content } = splitTimestampPrefix(trimmedStart);
    const matchText = content || trimmedStart;

    if (skipIndentedResidue) {
      if (/^\s*[-*•]\s+/.test(line) || /^\s{2,}\S/.test(line)) {
        continue;
      }
      skipIndentedResidue = false;
    }

    if (shouldSkipLine(line)) {
      skipIndentedResidue = /\[tools\]\s+(read failed|web_fetch failed)/i.test(trimmedStart);
      continue;
    }

    if (
      (trimmedStart.startsWith('"') ||
        trimmedStart === "}" ||
        trimmedStart === "{" ||
        trimmedStart.startsWith("}") ||
        trimmedStart.startsWith("{")) &&
      !trimmedStart.startsWith("[") &&
      !trimmedStart.startsWith("#")
    ) {
      // Tail can cut in the middle of a JSON blob; drop orphaned JSON fragments.
      continue;
    }

    const laneWait = matchText.match(
      /(?:^\[[^\]]+\]\s+)?lane wait exceeded:\s+lane=([^\s]+)\s+waitedMs=(\d+)\s+queueAhead=(\d+)/,
    );
    if (laneWait) {
      const lane = laneWait[1] ?? "unknown";
      const waited = formatDurationSeconds(laneWait[2]);
      const queueAhead = laneWait[3] ?? "unknown";
      addGroup(
        `lane:${lane}:${queueAhead}`,
        `[diagnostic] lane wait exceeded: ${lane} · last ${waited} · queueAhead ${queueAhead}`,
      );
      continue;
    }

    if (matchText.includes("context-engine onSubagentEnded failed (best-effort)")) {
      addGroup(
        "subagent-ended-best-effort",
        "[agents/subagent-registry] context-engine onSubagentEnded failed (best-effort)",
      );
      continue;
    }

    if (matchText.includes("Failed to create one-task flow for detached run")) {
      addGroup(
        "detached-flow-create-failed",
        "[tasks/executor] Failed to create one-task flow for detached run",
      );
      continue;
    }

    if (matchText.includes("[context-overflow-diag]")) {
      const sessionKey = matchText.match(/\bsessionKey=([^\s]+)/)?.[1] ?? null;
      const provider = matchText.match(/\bprovider=([^\s]+)/)?.[1] ?? null;
      const messages = matchText.match(/\bmessages=([^\s]+)/)?.[1] ?? "unknown";
      if (sessionKey && provider) {
        addGroup(
          `overflow:${sessionKey}:${provider}`,
          `[agent/embedded] context overflow: ${sessionKey} · provider ${provider} · last messages ${messages}`,
        );
        continue;
      }
    }

    const autoCompaction = matchText.match(
      /context overflow detected \(attempt \d+\/\d+\); attempting auto-compaction for ([^\s]+)/,
    );
    if (autoCompaction) {
      const provider = autoCompaction[1] ?? "unknown";
      addGroup(
        `overflow-compaction:${provider}`,
        `[agent/embedded] context overflow auto-compaction attempted (${provider})`,
      );
      continue;
    }

    // "[openai-codex] Token refresh failed: 401 { ...json... }"
    const tokenRefresh = matchText.match(
      /^\[([^\]]+)\]\s+Token refresh failed:\s*(\d+)\s*(\{)?\s*$/,
    );
    if (tokenRefresh) {
      const tag = tokenRefresh[1] ?? "unknown";
      const status = tokenRefresh[2] ?? "unknown";
      const block = consumeJsonBlock(lines, i);
      if (block) {
        i = block.endIndex;
        const parsed = (() => {
          try {
            return JSON.parse(block.json) as {
              error?: { code?: string; message?: string };
            };
          } catch {
            return null;
          }
        })();
        const code = normalizeOptionalString(parsed?.error?.code) ?? null;
        const msg = normalizeOptionalString(parsed?.error?.message) ?? null;
        const msgShort = msg
          ? normalizeLowercaseStringOrEmpty(msg).includes("signing in again")
            ? "re-auth required"
            : shorten(msg, 52)
          : null;
        const base = `[${tag}] token refresh ${status}${code ? ` ${code}` : ""}${msgShort ? ` · ${msgShort}` : ""}`;
        addGroup(`token:${tag}:${status}:${code ?? ""}:${msgShort ?? ""}`, base);
        continue;
      }
    }

    // "Embedded agent failed before reply: OAuth token refresh failed for openai-codex: ..."
    const embedded = matchText.match(
      /^Embedded agent failed before reply:\s+OAuth token refresh failed for ([^:]+):/,
    );
    if (embedded) {
      const provider = normalizeOptionalString(embedded[1]) || "unknown";
      addGroup(`embedded:${provider}`, `Embedded agent: OAuth token refresh failed (${provider})`);
      continue;
    }

    // "[gws] ⇄ res ✗ agent ... errorCode=UNAVAILABLE errorMessage=Error: OAuth token refresh failed ... runId=..."
    if (
      matchText.startsWith("[gws]") &&
      matchText.includes("errorCode=UNAVAILABLE") &&
      matchText.includes("OAuth token refresh failed")
    ) {
      const normalized = normalizeGwsLine(matchText);
      addGroup(`gws:${normalized}`, normalized);
      continue;
    }

    addLine(line);
  }

  for (const g of groups.values()) {
    if (g.count <= 1) {
      continue;
    }
    out[g.index] = `${g.base} ×${g.count}`;
  }

  const deduped: string[] = [];
  for (const line of out) {
    if (deduped[deduped.length - 1] === line) {
      continue;
    }
    deduped.push(line);
  }

  if (deduped.length <= maxLines) {
    return deduped;
  }

  const head = Math.min(6, Math.floor(maxLines / 3));
  const tail = Math.max(1, maxLines - head - 1);
  const kept = [
    ...deduped.slice(0, head),
    `… ${deduped.length - head - tail} lines omitted …`,
    ...deduped.slice(-tail),
  ];
  return kept;
}

export { pickGatewaySelfPresence } from "../gateway-presence.js";
