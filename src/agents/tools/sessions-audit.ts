import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { normalizeOptionalString, readStringValue } from "../../shared/string-coerce.js";
import { truncateUtf16Safe } from "../../utils.js";
import { lookupExactSessionInLocalIndex } from "./sessions-index.js";
import { normalizeUserProvidedSessionKey } from "./sessions-key-normalization.js";

export type SessionAuditExportResult = {
  auditMode: "exact-session-redacted-export";
  auditComplete: boolean;
  auditGrade: boolean;
  redacted: true;
  canonicalKey: string;
  sessionId?: string;
  sessionFile?: string;
  exportPath?: string;
  lineCount?: number;
  transcriptSha256?: string;
  exportSha256?: string;
  truncationMarkersDetected?: boolean;
  incompleteReason?: string;
};

const TRUNCATION_MARKER_RE =
  /(\[\.\.\.\s*\d+\s+more characters truncated\]|\.\.\.\[truncated\]\.\.\.|\.\.\.\(truncated\)\.\.\.|…\(truncated\)…|\(truncated\)|output truncated|more characters truncated)/i;

const SAFE_TOP_LEVEL_STRING_KEYS = new Set([
  "type",
  "id",
  "parentId",
  "role",
  "name",
  "status",
  "finishReason",
  "model",
]);

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shortSafeString(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  return truncateUtf16Safe(redactToolPayloadText(normalized), 160);
}

function countArray(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function summarizeMessage(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  const role = shortSafeString(record.role);
  const toolCallCount = countArray(record.tool_calls) ?? countArray(record.toolCalls);
  const contentBlockCount = countArray(record.content);
  return {
    ...(role ? { role } : {}),
    ...(contentBlockCount !== undefined ? { contentBlocks: contentBlockCount } : {}),
    ...(typeof record.content === "string" ? { contentRedacted: true } : {}),
    ...(toolCallCount !== undefined ? { toolCallCount } : {}),
    redactedBody: true,
  };
}

function summarizeTranscriptRecord(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { redacted: true };
  for (const key of SAFE_TOP_LEVEL_STRING_KEYS) {
    const value = key === "role" ? undefined : shortSafeString(parsed[key]);
    if (value) {
      out[key] = value;
    }
  }
  const message = summarizeMessage(parsed.message);
  if (message) {
    out.message = message;
  }
  const toolName = shortSafeString(parsed.toolName ?? parsed.name);
  if (toolName) {
    out.toolName = toolName;
  }
  if (parsed.type === "compaction") {
    out.compaction = { redactedBody: true };
  }
  return out;
}

function redactTranscriptLine(rawLine: string): Record<string, unknown> {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return { blank: true };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { nonObjectJson: true, redacted: true };
    }
    return summarizeTranscriptRecord(parsed as Record<string, unknown>);
  } catch {
    return { invalidJson: true, redacted: true };
  }
}

function splitPhysicalLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function defaultAuditExportDir(): string {
  try {
    return path.join(resolveStateDir(), "session-audits");
  } catch {
    return path.join(os.tmpdir(), "openclaw-session-audits");
  }
}

export function buildAuditIncompleteResult(params: {
  sessionKey: string;
  defaultAgentId?: string;
  reason: string;
}): SessionAuditExportResult {
  return {
    auditMode: "exact-session-redacted-export",
    auditComplete: false,
    auditGrade: false,
    redacted: true,
    canonicalKey: normalizeUserProvidedSessionKey(params.sessionKey, {
      defaultAgentId: params.defaultAgentId,
    }),
    incompleteReason: params.reason,
  };
}

export async function exportExactSessionAudit(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  defaultAgentId?: string;
  exportDir?: string;
}): Promise<SessionAuditExportResult> {
  const lookup = lookupExactSessionInLocalIndex({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    defaultAgentId: params.defaultAgentId,
  });
  if (!lookup.ok) {
    return buildAuditIncompleteResult({
      sessionKey: params.sessionKey,
      defaultAgentId: params.defaultAgentId,
      reason: lookup.error,
    });
  }

  const canonicalKey = lookup.row.canonicalKey;
  const sessionFile = lookup.row.filePath;
  let raw: Buffer;
  try {
    raw = await fs.readFile(sessionFile);
  } catch (err) {
    return {
      ...buildAuditIncompleteResult({
        sessionKey: canonicalKey,
        defaultAgentId: lookup.agentId,
        reason: `Failed to read session transcript: ${formatErrorMessage(err)}`,
      }),
      sessionId: lookup.row.sessionId,
      sessionFile,
    };
  }

  const transcriptSha256 = sha256Hex(raw);
  const text = raw.toString("utf8");
  const physicalLines = splitPhysicalLines(text);
  const truncationMarkersDetected = TRUNCATION_MARKER_RE.test(text);
  const header = {
    schemaVersion: 1,
    kind: "openclaw.session.audit.redacted",
    auditMode: "exact-session-redacted-export",
    auditComplete: !truncationMarkersDetected,
    canonicalKey,
    sessionId: lookup.row.sessionId,
    sessionFile,
    transcriptSha256,
    lineCount: physicalLines.length,
    redacted: true,
    ...(truncationMarkersDetected
      ? {
          incompleteReason: "Transcript contains truncation markers; audit evidence is incomplete.",
        }
      : {}),
  };
  const exportLines = [JSON.stringify(header)];
  for (const [index, rawLine] of physicalLines.entries()) {
    exportLines.push(
      JSON.stringify({
        lineNumber: index + 1,
        lineSha256: sha256Hex(rawLine),
        redacted: redactTranscriptLine(rawLine),
      }),
    );
  }
  const exportText = `${exportLines.join("\n")}\n`;
  const exportSha256 = sha256Hex(exportText);
  const exportDir = params.exportDir ?? defaultAuditExportDir();
  await fs.mkdir(exportDir, { recursive: true });
  const safeSessionId = lookup.row.sessionId.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80);
  const keyHash = sha256Hex(canonicalKey).slice(0, 12);
  const exportPath = path.join(
    exportDir,
    `openclaw-session-audit-${safeSessionId}-${keyHash}.jsonl`,
  );
  await fs.writeFile(exportPath, exportText, "utf8");

  return {
    auditMode: "exact-session-redacted-export",
    auditComplete: !truncationMarkersDetected,
    auditGrade: !truncationMarkersDetected,
    redacted: true,
    canonicalKey,
    sessionId: lookup.row.sessionId,
    sessionFile,
    exportPath,
    lineCount: physicalLines.length,
    transcriptSha256,
    exportSha256,
    ...(truncationMarkersDetected
      ? {
          truncationMarkersDetected: true,
          incompleteReason: "Transcript contains truncation markers; audit evidence is incomplete.",
        }
      : {}),
  };
}

export function fullAuditModePointer(sessionKey: string): Record<string, unknown> {
  return {
    tool: "sessions_history",
    arguments: {
      sessionKey,
      audit: true,
    },
    note: "Use file-backed exact-session redacted export mode; bounded history views are not audit-grade.",
  };
}
