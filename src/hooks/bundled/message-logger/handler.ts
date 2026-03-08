/**
 * Message Logger Hook
 *
 * Saves all chat conversations (inbound + outbound) as organized Markdown
 * files in the workspace.  Each contact or group gets its own folder with
 * daily Markdown files and a `media/` sub-directory for attachments.
 *
 * Events: message:received, message:sent
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import { loadConfig } from "../../../config/config.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import {
  isMessageReceivedEvent,
  isMessageSentEvent,
  type MessageReceivedHookContext,
  type MessageSentHookContext,
} from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/message-logger");

const MEDIA_PLACEHOLDER_RE = /^<media:[^>]+>(\s*\([^)]*\))?$/i;

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

export function getWorkspaceDir(cfg: Record<string, unknown>): string {
  const agents = cfg.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const workspace = defaults?.workspace;
  if (typeof workspace === "string" && workspace) {
    return workspace;
  }
  if (typeof workspace === "object" && workspace !== null) {
    const dir = (workspace as Record<string, unknown>).dir;
    if (typeof dir === "string" && dir) {
      return dir;
    }
  }
  const top = cfg.workspace;
  if (typeof top === "string" && top) {
    return top;
  }
  if (typeof top === "object" && top !== null) {
    const dir = (top as Record<string, unknown>).dir;
    if (typeof dir === "string" && dir) {
      return dir;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// contacts-map.json cache
// ---------------------------------------------------------------------------

const CONTACTS_MAP_TTL_MS = 5 * 60 * 1000;

let contactsMapCache: {
  byPhone: Map<string, string>;
  loadedAt: number;
  workspaceDir: string;
} | null = null;

function loadContactsMap(workspaceDir: string): Map<string, string> {
  const mapPath = path.join(workspaceDir, "memory", "contacts-map.json");
  const byPhone = new Map<string, string>();
  try {
    const raw = fs.readFileSync(mapPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [key, name] of Object.entries(parsed)) {
      if (typeof name !== "string" || !name) {
        continue;
      }
      const digits = key.replace(/\D/g, "");
      if (digits) {
        byPhone.set(digits, name);
      }
      // Also store the raw key for non-phone identifiers (Discord IDs, emails)
      if (key !== digits) {
        byPhone.set(key, name);
      }
    }
  } catch {
    log.debug(`contacts-map.json not found or invalid at ${mapPath}`);
  }
  return byPhone;
}

export function getContactsMap(cfg: Record<string, unknown>): Map<string, string> {
  const workspaceDir = getWorkspaceDir(cfg);
  if (!workspaceDir) {
    return new Map();
  }
  const now = Date.now();
  if (
    contactsMapCache &&
    contactsMapCache.workspaceDir === workspaceDir &&
    now - contactsMapCache.loadedAt < CONTACTS_MAP_TTL_MS
  ) {
    return contactsMapCache.byPhone;
  }
  const byPhone = loadContactsMap(workspaceDir);
  contactsMapCache = { byPhone, loadedAt: now, workspaceDir };
  return byPhone;
}

/** Invalidate the in-memory contacts-map cache so the next read reloads from disk. */
export function invalidateContactsMapCache(): void {
  contactsMapCache = null;
}

// ---------------------------------------------------------------------------
// Auto-discovery: learn contact names from any channel's metadata
// ---------------------------------------------------------------------------

function buildTelegramName(metadata?: Record<string, unknown>): string | undefined {
  const first = metadata?.first_name as string | undefined;
  const last = metadata?.last_name as string | undefined;
  if (first && last) return `${first} ${last}`;
  return first || last || undefined;
}

export async function autoDiscoverContact(
  identifier: string,
  metadata: Record<string, unknown> | undefined,
  cfg: Record<string, unknown>,
): Promise<string | null> {
  const senderName =
    (metadata?.senderName as string) ??
    (metadata?.displayName as string) ??
    (metadata?.profileName as string) ??
    (metadata?.real_name as string) ??
    buildTelegramName(metadata);

  if (!senderName) return null;

  const workspaceDir = getWorkspaceDir(cfg);
  if (!workspaceDir) return null;

  const mapPath = path.join(workspaceDir, "memory", "contacts-map.json");
  const phone = identifier.split("@")[0] ?? identifier;

  let map: Record<string, string> = {};
  try {
    map = JSON.parse(await fs.promises.readFile(mapPath, "utf-8")) as Record<string, string>;
  } catch {
    // File doesn't exist yet — will be created
  }

  const digits = phone.replace(/\D/g, "");
  if (map[digits] || map[phone]) return null;

  map[digits || phone] = senderName;
  await fs.promises.mkdir(path.dirname(mapPath), { recursive: true });
  await fs.promises.writeFile(mapPath, JSON.stringify(map, null, 2), "utf-8");

  invalidateContactsMapCache();

  log.info(`Auto-discovered contact: ${phone} → ${senderName}`);
  return senderName;
}

// ---------------------------------------------------------------------------
// Output directory resolution
// ---------------------------------------------------------------------------

export function resolveOutputDir(
  hookConfig: Record<string, unknown> | undefined,
  cfg: Record<string, unknown>,
): string {
  if (hookConfig?.outputDir && typeof hookConfig.outputDir === "string") {
    return hookConfig.outputDir;
  }
  const workspaceDir = getWorkspaceDir(cfg);
  if (!workspaceDir) {
    return "";
  }
  return path.join(workspaceDir, "chat-history");
}

// ---------------------------------------------------------------------------
// Contact resolution
// ---------------------------------------------------------------------------

export function slugifyContact(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function resolveContactInfo(
  identifier: string,
  metadata?: Record<string, unknown>,
  cfg?: Record<string, unknown>,
): { name: string; phone: string } {
  const phone = (metadata?.senderE164 as string) ?? identifier.split("@")[0] ?? "";

  // 1. senderName from metadata (WhatsApp/Discord/Signal/Slack/iMessage)
  const senderName =
    (metadata?.senderName as string | undefined) ??
    (metadata?.displayName as string | undefined) ??
    (metadata?.profileName as string | undefined) ??
    (metadata?.real_name as string | undefined) ??
    buildTelegramName(metadata);
  if (senderName) {
    return { name: senderName, phone };
  }

  // 2. contacts-map.json (cached, reloaded every 5 min)
  if (cfg) {
    const contactsMap = getContactsMap(cfg);
    const digits = phone.replace(/\D/g, "");
    const mapName = contactsMap.get(digits) ?? contactsMap.get(phone);
    if (mapName) {
      return { name: mapName, phone };
    }
  }

  // 3. Fallback: sanitized phone / identifier
  return { name: phone, phone };
}

// ---------------------------------------------------------------------------
// Group vs. individual resolution
// ---------------------------------------------------------------------------

function resolveGroupOrContactInfo(
  identifier: string,
  metadata?: Record<string, unknown>,
  cfg?: Record<string, unknown>,
): {
  folderName: string;
  folderSlug: string;
  phone: string;
  senderLabel?: string;
  isGroup: boolean;
} {
  const chatType = metadata?.chatType as string | undefined;
  const groupSubject = metadata?.groupSubject as string | undefined;

  if (chatType === "group" && groupSubject) {
    const { name: senderName } = resolveContactInfo(identifier, metadata, cfg);
    return {
      folderName: groupSubject,
      folderSlug: slugifyContact(groupSubject),
      phone: identifier.split("@")[0] ?? "",
      senderLabel: senderName,
      isGroup: true,
    };
  }

  const { name, phone } = resolveContactInfo(identifier, metadata, cfg);
  return {
    folderName: name,
    folderSlug: slugifyContact(name),
    phone,
    isGroup: false,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function formatDateSection(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

function buildFilePath(outputDir: string, contactSlug: string, date: Date): string {
  const dateStr = formatDateSection(date);
  return path.join(outputDir, contactSlug, `${dateStr}.md`);
}

function guessExtension(mimeType?: string): string {
  if (!mimeType) return "";
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  };
  return map[normalized] ?? "";
}

function classifyMedia(mimeType?: string): string {
  if (!mimeType) return "file";
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "document";
  return "file";
}

function formatTimestampCompact(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}${m}${s}`;
}

// ---------------------------------------------------------------------------
// Media copy
// ---------------------------------------------------------------------------

async function copyMediaToHistory(
  sourcePaths: string[],
  mediaTypes: string[] | undefined,
  outputDir: string,
  contactSlug: string,
  date: Date,
): Promise<Array<{ label: string; relativePath: string }>> {
  const mediaDir = path.join(outputDir, contactSlug, "media");
  const results: Array<{ label: string; relativePath: string }> = [];

  for (let i = 0; i < sourcePaths.length; i++) {
    const src = sourcePaths[i];
    if (!src) continue;

    try {
      try {
        await fs.promises.access(src, fs.constants.F_OK);
      } catch {
        log.debug(`Media file not found, skipping copy: ${src}`);
        continue;
      }

      await fs.promises.mkdir(mediaDir, { recursive: true });

      const ext = path.extname(src) || guessExtension(mediaTypes?.[i]);
      const dateStr = formatDateSection(date);
      const timeStr = formatTimestampCompact(date);
      const destName = `${dateStr}-${timeStr}-${i}${ext}`;
      const destPath = path.join(mediaDir, destName);

      await fs.promises.copyFile(src, destPath);

      const label = classifyMedia(mediaTypes?.[i]);
      results.push({ label, relativePath: `media/${destName}` });
    } catch (err) {
      log.debug(`Failed to copy media file ${src}: ${String(err)}`);
      const label = classifyMedia(mediaTypes?.[i]);
      results.push({ label, relativePath: path.basename(src) });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Serialized write queue (per-contact, prevents race conditions)
// ---------------------------------------------------------------------------

const writeQueues = new Map<string, Promise<void>>();

async function serializedAppend(contactSlug: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(contactSlug) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(contactSlug, next);

  try {
    await next;
  } finally {
    if (writeQueues.get(contactSlug) === next) {
      writeQueues.delete(contactSlug);
    }
  }
}

// ---------------------------------------------------------------------------
// Log entry building + append
// ---------------------------------------------------------------------------

type LogEntry = {
  direction: "\u2190" | "\u2192"; // ← or →
  senderLabel?: string;
  textContent?: string;
  transcript?: string;
  mediaEntries?: Array<{ label: string; relativePath: string }>;
  isAudioWithoutTranscript?: boolean;
};

export async function appendToLog(
  filePath: string,
  contactName: string,
  phone: string,
  date: Date,
  entry: LogEntry,
): Promise<void> {
  const dirPath = path.dirname(filePath);
  const dateStr = formatDateSection(date);
  const timeStr = formatTimestamp(date);

  await fs.promises.mkdir(dirPath, { recursive: true });

  let existingContent = "";
  try {
    existingContent = await fs.promises.readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist — will be created
  }

  let prefix = "";
  if (!existingContent) {
    prefix = `# Chat: ${contactName}${phone ? ` (${phone})` : ""}\n## ${dateStr}\n\n`;
  } else if (!existingContent.includes(`## ${dateStr}`)) {
    prefix = `\n## ${dateStr}\n\n`;
  }

  const lines: string[] = [];
  const senderPrefix = entry.senderLabel ? `**${entry.senderLabel}**: ` : "";

  if (entry.transcript) {
    lines.push(`${entry.direction} ${timeStr} | ${senderPrefix}\u{1F3A4} [audio]`);
    for (const tl of entry.transcript.split("\n")) {
      lines.push(`    > ${tl}`);
    }
  } else if (entry.isAudioWithoutTranscript) {
    lines.push(
      `${entry.direction} ${timeStr} | ${senderPrefix}\u{1F3A4} [audio without transcript]`,
    );
  }

  if (entry.mediaEntries?.length) {
    for (const me of entry.mediaEntries) {
      if (me.label === "audio" && (entry.transcript || entry.isAudioWithoutTranscript)) {
        continue;
      }
      lines.push(
        `${entry.direction} ${timeStr} | ${senderPrefix}\u{1F4CE} [${me.label}: ${me.relativePath}]`,
      );
    }
  }

  if (entry.textContent && !entry.transcript) {
    const formatted = entry.textContent.replace(/\n/g, "\n    ");
    lines.push(`${entry.direction} ${timeStr} | ${senderPrefix}${formatted}`);
  }

  if (lines.length === 0) {
    lines.push(`${entry.direction} ${timeStr} | ${senderPrefix}[empty message]`);
  }

  const fullEntry = prefix + lines.join("\n") + "\n";

  await fs.promises.appendFile(filePath, fullEntry, "utf-8");
}

// ---------------------------------------------------------------------------
// Inbound message handler
// ---------------------------------------------------------------------------

async function handleMessageReceived(ctx: MessageReceivedHookContext): Promise<void> {
  const cfg = loadConfig();
  const cfgRec = cfg as unknown as Record<string, unknown>;
  const hookConfig = resolveHookConfig(cfg, "message-logger");

  if (hookConfig?.enabled === false) return;

  const outputDir = resolveOutputDir(hookConfig as Record<string, unknown> | undefined, cfgRec);
  if (!outputDir) {
    log.debug("No output directory resolved, skipping message log");
    return;
  }

  // Auto-discover contact from metadata before resolving
  await autoDiscoverContact(ctx.from, ctx.metadata, cfgRec);

  const info = resolveGroupOrContactInfo(ctx.from, ctx.metadata, cfgRec);
  const date = ctx.timestamp ? new Date(ctx.timestamp * 1000) : new Date();
  const filePath = buildFilePath(outputDir, info.folderSlug, date);

  const mediaPaths = ctx.metadata?.mediaPaths as string[] | undefined;
  const mediaTypes = ctx.metadata?.mediaTypes as string[] | undefined;
  const transcript = ctx.metadata?.transcript as string | undefined;
  const mediaRemoteHost = ctx.metadata?.mediaRemoteHost as string | undefined;

  const hasAudio = mediaTypes?.some((t) => t.startsWith("audio/")) ?? false;

  let mediaEntries: Array<{ label: string; relativePath: string }> = [];
  if (mediaPaths?.length && !mediaRemoteHost) {
    mediaEntries = await copyMediaToHistory(
      mediaPaths,
      mediaTypes,
      outputDir,
      info.folderSlug,
      date,
    );
  } else if (mediaPaths?.length && mediaRemoteHost) {
    mediaEntries = mediaPaths.map((p, i) => ({
      label: classifyMedia(mediaTypes?.[i]),
      relativePath: path.basename(p),
    }));
  }

  const rawText = ctx.content?.trim() || undefined;
  const textContent = rawText && !MEDIA_PLACEHOLDER_RE.test(rawText) ? rawText : undefined;

  const headerPhone = info.isGroup ? "" : info.phone;

  await serializedAppend(info.folderSlug, () =>
    appendToLog(filePath, info.folderName, headerPhone, date, {
      direction: "\u2190",
      senderLabel: info.isGroup ? info.senderLabel : undefined,
      textContent,
      transcript,
      mediaEntries: mediaEntries.length > 0 ? mediaEntries : undefined,
      isAudioWithoutTranscript: hasAudio && !transcript,
    }),
  );

  log.debug(`Logged inbound message from ${info.folderName} to ${filePath}`);
}

// ---------------------------------------------------------------------------
// Outbound message handler
// ---------------------------------------------------------------------------

async function handleMessageSent(ctx: MessageSentHookContext): Promise<void> {
  if (!ctx.success) return;

  const cfg = loadConfig();
  const cfgRec = cfg as unknown as Record<string, unknown>;
  const hookConfig = resolveHookConfig(cfg, "message-logger");

  if (hookConfig?.enabled === false) return;

  const outputDir = resolveOutputDir(hookConfig as Record<string, unknown> | undefined, cfgRec);
  if (!outputDir) return;

  const isGroup = ctx.to.includes("@g.us");
  let folderSlug: string;
  let headerName: string;
  let headerPhone: string;

  if (isGroup) {
    const groupId = ctx.to.split("@")[0] ?? ctx.to;
    folderSlug = slugifyContact(groupId);
    headerName = groupId;
    headerPhone = "";
  } else {
    const { name, phone } = resolveContactInfo(ctx.to, undefined, cfgRec);
    folderSlug = slugifyContact(name);
    headerName = name;
    headerPhone = phone;
  }

  const date = new Date();
  const filePath = buildFilePath(outputDir, folderSlug, date);

  const rawText = ctx.content?.trim() || undefined;
  const textContent = rawText && !MEDIA_PLACEHOLDER_RE.test(rawText) ? rawText : undefined;

  await serializedAppend(folderSlug, () =>
    appendToLog(filePath, headerName, headerPhone, date, {
      direction: "\u2192",
      textContent,
    }),
  );

  log.debug(`Logged outbound message to ${headerName} at ${filePath}`);
}

// ---------------------------------------------------------------------------
// Hook entry point (matches bundled hook pattern)
// ---------------------------------------------------------------------------

const handler: HookHandler = async (event) => {
  try {
    if (isMessageReceivedEvent(event)) {
      await handleMessageReceived(event.context);
    } else if (isMessageSentEvent(event)) {
      await handleMessageSent(event.context);
    }
  } catch (err) {
    log.error(`Failed to log message: ${String(err)}`);
  }
};

export default handler;
