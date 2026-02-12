import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  type SessionEntry,
} from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("session-memory-snapshot");
const DEFAULT_MESSAGE_COUNT = 20;
const RAW_FALLBACK_MAX_CHARS = 2_000;

type SessionLogMessage = {
  role: "user" | "assistant";
  text: string;
};

function sanitizeSlug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const collapsed = normalized.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return (collapsed || "session-reset").slice(0, 48);
}

function extractMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const segments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const text = record.text.trim();
    if (text) {
      segments.push(text);
    }
  }
  if (segments.length === 0) {
    return null;
  }
  return segments.join("\n");
}

function parseSessionMessages(rawContent: string): SessionLogMessage[] {
  const parsed: SessionLogMessage[] = [];
  const lines = rawContent.split("\n");
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    try {
      const entry = JSON.parse(trimmedLine) as {
        type?: unknown;
        message?: { role?: unknown; content?: unknown };
      };
      if (entry.type !== "message" || !entry.message) {
        continue;
      }
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      const text = extractMessageText(entry.message.content);
      if (!text || text.startsWith("/")) {
        continue;
      }
      parsed.push({ role, text });
    } catch {
      // Non-JSONL lines are handled by the raw-content fallback.
    }
  }
  return parsed;
}

async function readSnapshotBody(params: {
  sessionFile: string;
  messageCount: number;
}): Promise<{ heading: string; body: string } | null> {
  try {
    const rawContent = await fs.readFile(params.sessionFile, "utf-8");
    const messages = parseSessionMessages(rawContent);
    if (messages.length > 0) {
      const recent = messages.slice(-params.messageCount);
      const lines = recent.map((entry) => `${entry.role}: ${entry.text}`);
      return { heading: "Recent Messages", body: lines.join("\n") };
    }
    const fallback = rawContent.trim();
    if (!fallback) {
      return null;
    }
    const excerpt = fallback.slice(-RAW_FALLBACK_MAX_CHARS);
    return { heading: "Raw Transcript Excerpt", body: excerpt };
  } catch {
    return null;
  }
}

export async function saveSessionSnapshotToMemory(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionEntry: SessionEntry;
  reason: string;
  source?: string;
  messageCount?: number;
}): Promise<string | null> {
  const sessionId = params.sessionEntry.sessionId?.trim();
  if (!sessionId) {
    return null;
  }
  const normalizedSessionKey = params.sessionKey.trim();
  if (!normalizedSessionKey) {
    return null;
  }

  try {
    const agentId = resolveAgentIdFromSessionKey(normalizedSessionKey);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const sessionFile =
      params.sessionEntry.sessionFile ||
      resolveSessionFilePath(sessionId, params.sessionEntry, { agentId });
    if (!sessionFile) {
      return null;
    }

    const messageCount = Math.max(1, Math.floor(params.messageCount ?? DEFAULT_MESSAGE_COUNT));
    const snapshotBody = await readSnapshotBody({ sessionFile, messageCount });

    const now = new Date();
    const iso = now.toISOString();
    const [datePartRaw, timePartRaw] = iso.split("T");
    const datePart = datePartRaw ?? now.toISOString().slice(0, 10);
    const timePart = (timePartRaw ?? "00:00:00Z").split(".")[0] ?? "00:00:00Z";
    const compactTime = timePart.replace(/:/g, "").slice(0, 6);
    const slug = sanitizeSlug(params.reason);
    const unique = randomUUID().slice(0, 6);

    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    const fileName = `${datePart}-${compactTime}-${slug}-${unique}.md`;
    const filePath = path.join(memoryDir, fileName);
    const source = params.source?.trim() || "auto-recovery";

    const lines = [
      `# Session Snapshot: ${datePart} ${timePart} UTC`,
      "",
      `- **Reason**: ${params.reason}`,
      `- **Session Key**: ${normalizedSessionKey}`,
      `- **Session ID**: ${sessionId}`,
      `- **Source**: ${source}`,
      "",
    ];
    if (snapshotBody) {
      lines.push(`## ${snapshotBody.heading}`, "", snapshotBody.body, "");
    } else {
      lines.push("## Notes", "", "(No transcript content could be extracted.)", "");
    }

    await fs.writeFile(filePath, lines.join("\n"), "utf-8");
    return filePath;
  } catch (err) {
    log.warn(`failed to write session snapshot: ${String(err)}`);
    return null;
  }
}
