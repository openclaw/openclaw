import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

const log = createSubsystemLogger("sessions-archive");

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const msg = message as { content?: unknown; text?: unknown; message?: unknown };
  if (typeof msg.text === "string") {
    return msg.text;
  }
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const entry = part as { type?: string; text?: string };
        if (entry.type === "text" && typeof entry.text === "string") {
          return entry.text;
        }
        return "";
      })
      .filter(Boolean);
    return parts.join(" ").trim();
  }
  return "";
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trim()}…`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function resolveUniquePath(dir: string, baseName: string): Promise<string> {
  let candidate = path.join(dir, baseName);
  if (!(await fileExists(candidate))) {
    return candidate;
  }
  for (let i = 2; i < 1000; i += 1) {
    candidate = path.join(dir, baseName.replace(/\.md$/i, `-${i}.md`));
    if (!(await fileExists(candidate))) {
      return candidate;
    }
  }
  return path.join(dir, `${Date.now()}-${baseName}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeSessionArchiveSummary(params: {
  cfg: OpenClawConfig;
  key: string;
  entry: SessionEntry;
  storePath?: string;
  archivedAt?: number | null;
}): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const { cfg, key, entry, storePath } = params;
  const archivedAt = typeof params.archivedAt === "number" ? params.archivedAt : Date.now();
  const sessionId = entry.sessionId;
  if (!sessionId) {
    return { ok: false, reason: "missing sessionId" };
  }

  const messages = readSessionMessages(sessionId, storePath, entry.sessionFile);
  if (!messages.length) {
    return { ok: false, reason: "no transcript" };
  }

  const userMessages = messages
    .filter((msg) => (msg as { role?: string })?.role === "user")
    .map((msg) => extractMessageText(msg))
    .filter((text) => text);

  const assistantMessages = messages
    .filter((msg) => (msg as { role?: string })?.role === "assistant")
    .map((msg) => extractMessageText(msg))
    .filter((text) => text);

  const firstUser = userMessages.slice(0, 3).map((text) => truncate(text));
  const lastUser = userMessages.slice(-3).map((text) => truncate(text));

  const label = entry.label?.trim() || entry.displayName?.trim() || entry.origin?.label?.trim();
  const displayLabel = label || key;
  const parsed = parseAgentSessionKey(key);
  const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const date = new Date(archivedAt).toISOString().slice(0, 10);
  const dir = path.join(workspaceDir, "memory");

  const baseSlug = slugify(displayLabel) || "session";
  const keySlug = slugify(key) || "session";
  const baseName = `${date}-${baseSlug}--${keySlug}.md`;

  await fs.mkdir(dir, { recursive: true });
  const filePath = await resolveUniquePath(dir, baseName);

  const summary = `# Session Summary\n\n- Session: ${displayLabel}\n- Key: \`${key}\`\n- Archived at: ${new Date(archivedAt).toISOString()}\n- Messages: ${messages.length} total (${userMessages.length} user, ${assistantMessages.length} assistant)\n\n## First user messages\n${
    firstUser.length ? firstUser.map((line) => `- ${line}`).join("\n") : "- (none)"
  }\n\n## Recent user messages\n${lastUser.length ? lastUser.map((line) => `- ${line}`).join("\n") : "- (none)"}\n`;

  await fs.writeFile(filePath, summary, "utf-8");
  log.info(`wrote archive summary to ${filePath}`);
  return { ok: true, path: filePath };
}
