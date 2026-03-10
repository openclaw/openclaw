import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../../config/config.js";
import { getContactManager } from "../../../contacts/contact-manager.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type {
  PluginHookMessageReceivedEvent,
  PluginHookMessageSentEvent,
  PluginHookMessageTranscribedEvent,
  PluginHookMessageContext,
} from "../../../plugins/types.js";
import { normalizeBrazilianMobile } from "../../../utils.js";
import { resolveHookConfig } from "../../config.js";

const log = createSubsystemLogger("hooks/message-logger");

const MEDIA_PLACEHOLDER_RE = /^<media:[^>]+>(\s*\([^)]*\))?$/i;

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

// --- contacts-map.json cache ---

const CONTACTS_MAP_TTL_MS = 5 * 60 * 1000;

type ContactMapEntry = { name: string; slug: string };

let contactsMapCache: {
  byPhone: Map<string, ContactMapEntry>;
  loadedAt: number;
  workspaceDir: string;
} | null = null;

function loadContactsMap(workspaceDir: string): Map<string, ContactMapEntry> {
  const byPhone = new Map<string, ContactMapEntry>();

  // 1. Try contacts-map.json (canonical source with pre-computed slugs)
  //    Format: { "556992747532": { "name": "Paola...", "slug": "paola-assami-financeiro" } }
  //    or legacy: { "+556992747532": "Paola..." }
  const mapPath = path.join(workspaceDir, "memory", "system", "contacts-map.json");
  try {
    const raw = fs.readFileSync(mapPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (key.includes("@")) {
        // Group entries — store by JID prefix (e.g. "120363424771379436")
        if (typeof value === "object" && value !== null && "slug" in value) {
          const entry = value as { name?: string; slug?: string };
          if (typeof entry.name === "string" && typeof entry.slug === "string") {
            const jidPrefix = key.split("@")[0] ?? key;
            byPhone.set(jidPrefix, { name: entry.name, slug: entry.slug });
          }
        }
        continue;
      }
      const digits = normalizeBrazilianMobile(key.replace(/\D/g, ""));
      if (!digits) {
        continue;
      }
      if (typeof value === "object" && value !== null && "slug" in value) {
        const entry = value as { name?: string; slug?: string };
        if (typeof entry.name === "string" && typeof entry.slug === "string") {
          byPhone.set(digits, { name: entry.name, slug: entry.slug });
        }
      } else if (typeof value === "string" && value) {
        // Legacy format: phone → name string
        byPhone.set(digits, { name: value, slug: slugifyContact(value) });
      }
    }
    if (byPhone.size > 0) {
      return byPhone;
    }
  } catch {
    log.debug(`contacts-map.json not found or invalid at ${mapPath}`);
  }

  // 2. Fallback: contacts-briefing.json v2 flat format
  //    Format: { "+556992747532": { "name": "Paola...", "slug": "paola-assami-financeiro", ... } }
  const briefingPath = path.join(workspaceDir, "memory", "system", "contacts-briefing.json");
  try {
    const raw = fs.readFileSync(briefingPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Detect v2 flat format: top-level keys are phone numbers (start with "+")
    const isV2 = Object.keys(parsed).some((k) => k.startsWith("+") && !k.startsWith("_"));

    if (isV2) {
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith("_")) {
          continue; // skip metadata keys like _generated, _version
        }
        if (typeof value !== "object" || value === null) {
          continue;
        }
        const entry = value as { name?: string; slug?: string };
        if (typeof entry.name !== "string") {
          continue;
        }
        const digits = normalizeBrazilianMobile(key.replace(/\D/g, ""));
        if (digits) {
          const slug = typeof entry.slug === "string" ? entry.slug : slugifyContact(entry.name);
          byPhone.set(digits, { name: entry.name, slug });
        }
      }
    } else {
      // Legacy category-based format: { contacts: { category: [{ name, whatsapp }] } }
      const legacy = parsed as {
        contacts?: Record<string, Array<{ name?: string; whatsapp?: string }>>;
      };
      if (legacy.contacts && typeof legacy.contacts === "object") {
        for (const category of Object.values(legacy.contacts)) {
          if (!Array.isArray(category)) {
            continue;
          }
          for (const item of category) {
            if (typeof item !== "object" || item === null) {
              continue;
            }
            if (typeof item.name !== "string" || typeof item.whatsapp !== "string") {
              continue;
            }
            const digits = normalizeBrazilianMobile(item.whatsapp.replace(/\D/g, ""));
            if (digits) {
              byPhone.set(digits, { name: item.name, slug: slugifyContact(item.name) });
            }
          }
        }
      }
    }
  } catch {
    log.debug(`contacts-briefing.json not found or invalid at ${briefingPath}`);
  }

  return byPhone;
}

export function getContactsMap(cfg: Record<string, unknown>): Map<string, ContactMapEntry> {
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
): { name: string; slug: string; phone: string } {
  // Extract phone from JID (e.g., "5569996021005@s.whatsapp.net" -> "5569996021005")
  const rawPhone = (metadata?.senderE164 as string) ?? identifier.split("@")[0] ?? "";
  // Normalize Brazilian mobile numbers (strip 9th digit: 13 -> 12 digits)
  const phoneDigits = rawPhone.replace(/\D/g, "");
  const phone = phoneDigits ? normalizeBrazilianMobile(phoneDigits) : rawPhone;

  // 1. Try contacts-map.json FIRST (canonical source with stable slugs)
  if (cfg) {
    const contactsMap = getContactsMap(cfg);
    const digits = normalizeBrazilianMobile(phone.replace(/\D/g, ""));
    const mapEntry = contactsMap.get(digits);
    if (mapEntry) {
      return { name: mapEntry.name, slug: mapEntry.slug, phone };
    }
  }

  // 2. Try contact manager (CONTATOS.md)
  try {
    const contact = getContactManager().findByPhone(phone);
    if (contact?.name) {
      return { name: contact.name, slug: slugifyContact(contact.name), phone };
    }
  } catch {
    // Contact manager may not be initialized
  }

  // 3. Try senderName from metadata (WhatsApp display name — unstable, used only as last resort)
  const senderName = metadata?.senderName as string | undefined;
  if (senderName) {
    return { name: senderName, slug: slugifyContact(senderName), phone };
  }

  // 4. Fallback: sanitized phone
  return { name: phone, slug: slugifyContact(phone), phone };
}

function formatTimestamp(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function formatDateSection(date: Date): string {
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
}

function buildFilePath(outputDir: string, contactSlug: string, date: Date): string {
  const dateStr = formatDateSection(date);
  return path.join(outputDir, contactSlug, `${dateStr}.md`);
}

// --- NEW: Utility functions ---

function guessExtension(mimeType?: string): string {
  if (!mimeType) {
    return "";
  }
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
  if (!mimeType) {
    return "arquivo";
  }
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) {
    return "imagem";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized === "application/pdf") {
    return "documento";
  }
  return "arquivo";
}

function formatTimestampCompact(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}${m}${s}`;
}

// --- NEW: Media copy ---

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
    if (!src) {
      continue;
    }

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

// --- NEW: Group vs contact resolution ---

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
    // For groups, check contacts-map for group JID slug
    let groupSlug = slugifyContact(groupSubject);
    if (cfg) {
      const contactsMap = getContactsMap(cfg);
      const groupJid = identifier.split("@")[0] ?? "";
      // Group entries in contacts-map use the full JID as key (e.g. "120363...@g.us")
      const groupEntry = contactsMap.get(groupJid);
      if (groupEntry) {
        groupSlug = groupEntry.slug;
      }
    }
    return {
      folderName: groupSubject,
      folderSlug: groupSlug,
      phone: identifier.split("@")[0] ?? "",
      senderLabel: senderName,
      isGroup: true,
    };
  }

  const { name, slug, phone } = resolveContactInfo(identifier, metadata, cfg);
  return {
    folderName: name,
    folderSlug: slug,
    phone,
    isGroup: false,
  };
}

// --- NEW: Write queue per contact (race condition mitigation) ---

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

// --- NEW: LogEntry type and async appendToLog ---

type LogEntry = {
  direction: "\u2190" | "\u2192";
  senderLabel?: string;
  textContent?: string;
  transcript?: string;
  mediaEntries?: Array<{ label: string; relativePath: string }>;
  isAudioWithoutTranscript?: boolean;
};

async function appendToLog(
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
    lines.push(`${entry.direction} ${timeStr} | ${senderPrefix}\u{1F3A4} [audio sem transcricao]`);
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
    lines.push(`${entry.direction} ${timeStr} | ${senderPrefix}[mensagem vazia]`);
  }

  const fullEntry = prefix + lines.join("\n") + "\n";

  await fs.promises.appendFile(filePath, fullEntry, "utf-8");
}

// --- Rewritten handlers ---

export async function messageLoggerReceivedHandler(
  event: PluginHookMessageReceivedEvent,
  _ctx: PluginHookMessageContext,
): Promise<void> {
  try {
    const cfg = loadConfig();
    const hookConfig = resolveHookConfig(cfg, "message-logger");

    if (hookConfig?.enabled === false) {
      return;
    }

    const outputDir = resolveOutputDir(
      hookConfig as Record<string, unknown> | undefined,
      cfg as unknown as Record<string, unknown>,
    );
    if (!outputDir) {
      log.debug("No output directory resolved, skipping message log");
      return;
    }

    const info = resolveGroupOrContactInfo(
      event.from,
      event.metadata,
      cfg as unknown as Record<string, unknown>,
    );
    const date = event.timestamp ? new Date(event.timestamp * 1000) : new Date();
    const filePath = buildFilePath(outputDir, info.folderSlug, date);

    // Extract media/transcript fields from metadata
    const mediaPaths = event.metadata?.mediaPaths as string[] | undefined;
    const mediaTypes = event.metadata?.mediaTypes as string[] | undefined;
    const transcript = event.metadata?.transcript as string | undefined;
    const mediaRemoteHost = event.metadata?.mediaRemoteHost as string | undefined;

    // Detect audio
    const hasAudio = mediaTypes?.some((t) => t.startsWith("audio/")) ?? false;

    // Copy media to history folder (or register URL if remote)
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
      // Remote media — register paths without copying
      mediaEntries = mediaPaths.map((p, i) => ({
        label: classifyMedia(mediaTypes?.[i]),
        relativePath: path.basename(p),
      }));
    }

    const rawText = event.content?.trim() || undefined;
    const textContent = rawText && !MEDIA_PLACEHOLDER_RE.test(rawText) ? rawText : undefined;

    // Header info
    const headerName = info.isGroup ? info.folderName : info.folderName;
    const headerPhone = info.isGroup ? "" : info.phone;

    await serializedAppend(info.folderSlug, () =>
      appendToLog(filePath, headerName, headerPhone, date, {
        direction: "\u2190",
        senderLabel: info.isGroup ? info.senderLabel : undefined,
        textContent,
        transcript,
        mediaEntries: mediaEntries.length > 0 ? mediaEntries : undefined,
        isAudioWithoutTranscript: hasAudio && !transcript,
      }),
    );

    log.debug(`Logged inbound message from ${info.folderName} to ${filePath}`);
  } catch (err) {
    log.error(`Failed to log received message: ${String(err)}`);
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function messageLoggerSentHandler(
  event: PluginHookMessageSentEvent,
  _ctx: PluginHookMessageContext,
): Promise<void> {
  try {
    // Only log successful deliveries
    if (!event.success) {
      return;
    }

    const cfg = loadConfig();
    const hookConfig = resolveHookConfig(cfg, "message-logger");

    if (hookConfig?.enabled === false) {
      return;
    }

    const outputDir = resolveOutputDir(
      hookConfig as Record<string, unknown> | undefined,
      cfg as unknown as Record<string, unknown>,
    );
    if (!outputDir) {
      return;
    }

    // Detect group via @g.us suffix
    const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
    const isGroup = event.to.includes("@g.us");
    let folderSlug: string;
    let headerName: string;
    let headerPhone: string;

    if (isGroup) {
      // For outbound group messages, use the group JID as slug
      const groupId = event.to.split("@")[0] ?? event.to;
      folderSlug = slugifyContact(groupId);
      headerName = groupId;
      headerPhone = "";
    } else {
      const { name, slug, phone } = resolveContactInfo(
        event.to,
        metadata,
        cfg as unknown as Record<string, unknown>,
      );
      folderSlug = slug;
      headerName = name;
      headerPhone = phone;
    }

    const date = new Date();
    const filePath = buildFilePath(outputDir, folderSlug, date);

    // Extract outbound media URLs from metadata
    const mediaUrls = metadata?.mediaUrls as string[] | undefined;
    let mediaEntries: Array<{ label: string; relativePath: string }> = [];
    if (mediaUrls?.length) {
      mediaEntries = mediaUrls.map((url) => ({
        label: classifyMedia(undefined),
        relativePath: path.basename(new URL(url).pathname),
      }));
    }

    const rawText = event.content?.trim() || undefined;
    const textContent = rawText && !MEDIA_PLACEHOLDER_RE.test(rawText) ? rawText : undefined;

    await serializedAppend(folderSlug, () =>
      appendToLog(filePath, headerName, headerPhone, date, {
        direction: "\u2192",
        textContent,
        mediaEntries: mediaEntries.length > 0 ? mediaEntries : undefined,
      }),
    );

    log.debug(`Logged outbound message to ${headerName} at ${filePath}`);
  } catch (err) {
    log.error(`Failed to log sent message: ${String(err)}`);
  }
}

export async function messageLoggerTranscribedHandler(
  event: PluginHookMessageTranscribedEvent,
  _ctx: PluginHookMessageContext,
): Promise<void> {
  try {
    const cfg = loadConfig();
    const hookConfig = resolveHookConfig(cfg, "message-logger");

    if (hookConfig?.enabled === false) {
      return;
    }

    const outputDir = resolveOutputDir(
      hookConfig as Record<string, unknown> | undefined,
      cfg as unknown as Record<string, unknown>,
    );
    if (!outputDir) {
      return;
    }

    const info = resolveGroupOrContactInfo(
      event.from,
      event.metadata,
      cfg as unknown as Record<string, unknown>,
    );
    const date = event.timestamp ? new Date(event.timestamp * 1000) : new Date();
    const filePath = buildFilePath(outputDir, info.folderSlug, date);

    await serializedAppend(info.folderSlug, async () => {
      let content = "";
      try {
        content = await fs.promises.readFile(filePath, "utf-8");
      } catch {
        return; // File doesn't exist — nothing to update
      }

      const timeStr = formatTimestamp(date);
      const senderPrefix =
        info.isGroup && info.senderLabel ? `\\*\\*${escapeRegex(info.senderLabel)}\\*\\*: ` : "";
      const needle = `\u2190 ${timeStr} \\| ${senderPrefix}\u{1F3A4} \\[audio sem transcricao\\]`;
      const re = new RegExp(needle);

      if (!re.test(content)) {
        return;
      }

      const transcriptLines = event.transcript
        .split("\n")
        .map((l) => `    > ${l}`)
        .join("\n");
      const senderText = info.isGroup && info.senderLabel ? `**${info.senderLabel}**: ` : "";
      const replacement = `\u2190 ${timeStr} | ${senderText}\u{1F3A4} [audio]\n${transcriptLines}`;

      const updated = content.replace(re, replacement);
      await fs.promises.writeFile(filePath, updated, "utf-8");
    });

    log.debug(`Updated transcript for ${info.folderName} at ${filePath}`);
  } catch (err) {
    log.error(`Failed to update transcript: ${String(err)}`);
  }
}
