/**
 * Chat History Hook Handler
 *
 * Logs incoming messages to flat markdown files for grep-based retrieval.
 * Follows Viktor's pattern: real-time capture, simple file structure.
 *
 * File structure:
 *   {workspace}/knowledge/chat-history/{channel}/
 *     ├── {YYYY-MM}.md           (all messages, monthly)
 *     └── groups/
 *         └── {group_id}/
 *             └── {YYYY-MM}.md   (per-group, monthly)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { ChatHistoryConfig } from "../../../config/types.chat-history.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("hooks/chat-history");

interface ChatHistoryLogEntry {
  timestamp: string;
  channel: string;
  groupId?: string;
  groupName?: string;
  userId: string;
  userName: string;
  message: string;
  replyTo?: string;
}

function formatTimestamp(date: Date, timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return date.toISOString().replace("Z", "");
  }
}

function getTimezoneAbbr(timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    });
    const parts = formatter.formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timezone;
  } catch {
    return timezone;
  }
}

function formatLogLine(entry: ChatHistoryLogEntry, config: ChatHistoryConfig): string {
  const tz = config.format?.timezone ?? "UTC";
  const tzAbbr = getTimezoneAbbr(tz);

  const parts: string[] = [];

  // Timestamp
  parts.push(`[${entry.timestamp} ${tzAbbr}]`);

  // User info
  if (config.format?.includeUserId) {
    parts.push(`**${entry.userName}** (uid:${entry.userId})`);
  } else {
    parts.push(`**${entry.userName}**`);
  }

  // Group info (if applicable)
  if (entry.groupId && config.format?.includeGroupId) {
    const groupLabel = entry.groupName
      ? `**${entry.groupName}** (gid:${entry.groupId})`
      : `(gid:${entry.groupId})`;
    parts.push(`in ${groupLabel}`);
  } else if (entry.groupName && config.format?.includeGroupName) {
    parts.push(`in **${entry.groupName}**`);
  }

  parts.push(":");

  // Reply context
  let messageText = entry.message;
  if (entry.replyTo && config.format?.includeReplyContext) {
    messageText = `[reply] ${messageText}`;
  }

  return `${parts.join(" ")}\n${messageText}\n\n`;
}

function isChannelEnabled(config: ChatHistoryConfig, channel: string): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!config.channels) {
    return true;
  } // All enabled by default
  const channelId = channel as keyof typeof config.channels;
  return config.channels[channelId] !== false;
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err: unknown) {
    const isNotExist =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
    if (!isNotExist) {
      throw err;
    }
  }
}

async function appendToFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, content, "utf-8");
}

/**
 * Chat history hook handler.
 * Logs incoming messages to flat markdown files.
 */
const logChatHistory: HookHandler = async (event) => {
  // Only handle message:received events
  if (event.type !== "message" || event.action !== "received") {
    return;
  }

  const context = event.context || {};
  const cfg = context.cfg as OpenClawConfig | undefined;

  // Get chat history config
  const config = cfg?.chatHistory;
  if (!config?.enabled) {
    return;
  }

  // Resolve workspace directory
  const contextWorkspaceDir =
    typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
      ? context.workspaceDir
      : undefined;
  const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
  const workspacePath =
    contextWorkspaceDir || (cfg ? resolveAgentWorkspaceDir(cfg, agentId) : undefined);

  if (!workspacePath) {
    log.debug("No workspace path available, skipping chat history log");
    return;
  }

  // Extract channel info
  const channel = (context.channelId as string) ?? "unknown";
  if (!isChannelEnabled(config, channel)) {
    log.debug(`Channel ${channel} not enabled for chat history`);
    return;
  }

  // Format timestamp
  const now = new Date((context.timestamp as number) ?? Date.now());
  const tz = config.format?.timezone ?? "UTC";
  const timestamp = formatTimestamp(now, tz);
  const yearMonth = timestamp.slice(0, 7); // YYYY-MM

  // Extract message metadata
  const groupId = (context.groupId ?? context.conversationId ?? "") as string;
  const groupName = (context.groupName ?? context.chatName ?? "") as string;
  const userId = (context.senderId ?? context.from ?? "") as string;
  const userName = (context.senderName ?? context.from ?? "Unknown") as string;
  const replyTo = (context.replyTo ?? context.replyToId ?? "") as string;
  const content = (context.content ?? context.body ?? "") as string;

  const entry: ChatHistoryLogEntry = {
    timestamp,
    channel,
    groupId: groupId || undefined,
    groupName: groupName || undefined,
    userId,
    userName,
    message: content,
    replyTo: replyTo || undefined,
  };

  const logLine = formatLogLine(entry, config);
  const basePath = path.join(
    workspacePath,
    config.storage?.path ?? "knowledge/chat-history",
    channel,
  );

  try {
    // Write to combined monthly file
    const combinedFile = path.join(basePath, `${yearMonth}.md`);
    await appendToFile(combinedFile, logLine);
    log.debug(`Logged message to ${combinedFile}`);

    // Write to per-group file if enabled
    if (config.storage?.splitByGroup && groupId) {
      const groupFile = path.join(basePath, "groups", groupId, `${yearMonth}.md`);
      await appendToFile(groupFile, logLine);
      log.debug(`Logged message to ${groupFile}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to log chat message: ${message}`);
  }
};

export default logChatHistory;
