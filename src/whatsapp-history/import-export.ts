/**
 * WhatsApp Export Importer
 * Parses WhatsApp chat exports (.txt files) and imports them to the database
 *
 * WhatsApp export format (varies by locale):
 * [DD/MM/YYYY, HH:MM:SS] Sender Name: Message content
 * [M/D/YY, H:MM:SS AM/PM] Sender Name: Message content
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { insertMessages, type MessageRecord, upsertChat, getStats } from "./db.js";

// Common WhatsApp export line patterns
const LINE_PATTERNS = [
  // European format: [DD/MM/YYYY, HH:MM:SS]
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]\s*([^:]+):\s*(.*)$/i,
  // US format: [M/D/YY, H:MM:SS AM/PM]
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s*-\s*([^:]+):\s*(.*)$/i,
  // Android format without brackets
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2})\s*-\s*([^:]+):\s*(.*)$/i,
];

// System message patterns (to skip or mark)
const SYSTEM_PATTERNS = [
  /created group/i,
  /added you/i,
  /changed the subject/i,
  /changed this group/i,
  /messages.*end-to-end encrypted/i,
  /security code changed/i,
  /left$/i,
  /removed$/i,
  /joined using/i,
];

interface ParsedLine {
  date: string;
  time: string;
  sender: string;
  message: string;
  isSystem: boolean;
}

function parseLine(line: string): ParsedLine | null {
  for (const pattern of LINE_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      const [, date, time, sender, message] = match;
      const isSystem = SYSTEM_PATTERNS.some((p) => p.test(message));
      return { date, time, sender: sender.trim(), message: message.trim(), isSystem };
    }
  }
  return null;
}

function parseDateTime(date: string, time: string): number {
  // Try various date formats
  const dateFormats = [
    // DD/MM/YYYY
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    // DD/MM/YY
    /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
    // M/D/YYYY
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  ];

  let day: number, month: number, year: number;

  for (const fmt of dateFormats) {
    const match = date.match(fmt);
    if (match) {
      // Assume DD/MM/YYYY for European format (most common)
      // This could be ambiguous, but we'll go with day-first
      [, day, month, year] = match.map(Number) as [any, number, number, number];
      if (year < 100) year += 2000;
      break;
    }
  }

  if (!day! || !month! || !year!) {
    // Fallback: try Date.parse
    const parsed = Date.parse(`${date} ${time}`);
    if (!isNaN(parsed)) return Math.floor(parsed / 1000);
    return Math.floor(Date.now() / 1000);
  }

  // Parse time
  let hours = 0,
    minutes = 0,
    seconds = 0;
  const timeMatch = time.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?/i);
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    seconds = parseInt(timeMatch[3] || "0", 10);
    const ampm = timeMatch[4]?.toUpperCase();
    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
  }

  const dt = new Date(year, month - 1, day, hours, minutes, seconds);
  return Math.floor(dt.getTime() / 1000);
}

function generateMessageId(
  chatJid: string,
  timestamp: number,
  sender: string,
  text: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${chatJid}|${timestamp}|${sender}|${text}`)
    .digest("hex")
    .slice(0, 20);
  return `import_${hash}`;
}

export interface ImportResult {
  file: string;
  chat_name: string;
  chat_jid: string;
  messages_found: number;
  messages_imported: number;
  messages_skipped: number;
  date_range: { oldest: number | null; newest: number | null };
}

export async function importExportFile(filePath: string, chatName?: string): Promise<ImportResult> {
  const fileName = path.basename(filePath, path.extname(filePath));
  const derivedChatName =
    chatName || fileName.replace(/^WhatsApp Chat with /i, "").replace(/_/g, " ");

  // Generate a pseudo-JID for imported chats
  const chatJid = `import_${crypto.createHash("md5").update(derivedChatName.toLowerCase()).digest("hex").slice(0, 12)}@import.local`;

  const messages: MessageRecord[] = [];
  let currentMessage: ParsedLine | null = null;
  let continuationBuffer = "";

  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const parsed = parseLine(line);

    if (parsed) {
      // Save previous message if exists
      if (currentMessage && !currentMessage.isSystem) {
        const fullMessage = continuationBuffer
          ? `${currentMessage.message}\n${continuationBuffer}`
          : currentMessage.message;

        const timestamp = parseDateTime(currentMessage.date, currentMessage.time);

        messages.push({
          id: generateMessageId(chatJid, timestamp, currentMessage.sender, fullMessage),
          chat_jid: chatJid,
          chat_name: derivedChatName,
          sender_name: currentMessage.sender,
          sender_jid: undefined,
          from_me: false, // We can't determine this from exports reliably
          timestamp,
          message_type: "text",
          text_content: fullMessage,
          source: "import",
        });
      }

      currentMessage = parsed;
      continuationBuffer = "";
    } else if (currentMessage) {
      // Continuation of previous message (multi-line)
      continuationBuffer += (continuationBuffer ? "\n" : "") + line;
    }
  }

  // Don't forget the last message
  if (currentMessage && !currentMessage.isSystem) {
    const fullMessage = continuationBuffer
      ? `${currentMessage.message}\n${continuationBuffer}`
      : currentMessage.message;

    const timestamp = parseDateTime(currentMessage.date, currentMessage.time);

    messages.push({
      id: generateMessageId(chatJid, timestamp, currentMessage.sender, fullMessage),
      chat_jid: chatJid,
      chat_name: derivedChatName,
      sender_name: currentMessage.sender,
      sender_jid: undefined,
      from_me: false,
      timestamp,
      message_type: "text",
      text_content: fullMessage,
      source: "import",
    });
  }

  // Register the chat
  upsertChat(chatJid, derivedChatName, derivedChatName.includes("group"));

  // Insert messages
  const imported = insertMessages(messages);

  // Calculate date range
  const timestamps = messages.map((m) => m.timestamp).filter((t) => t > 0);
  const oldest = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const newest = timestamps.length > 0 ? Math.max(...timestamps) : null;

  return {
    file: filePath,
    chat_name: derivedChatName,
    chat_jid: chatJid,
    messages_found: messages.length,
    messages_imported: imported,
    messages_skipped: messages.length - imported,
    date_range: { oldest, newest },
  };
}

export async function importDirectory(dirPath: string): Promise<ImportResult[]> {
  const results: ImportResult[] = [];

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".txt"));

  for (const file of files) {
    try {
      const result = await importExportFile(path.join(dirPath, file));
      results.push(result);
    } catch (err) {
      console.error(`Failed to import ${file}:`, err);
    }
  }

  return results;
}

export function formatImportResults(results: ImportResult[]): string {
  if (results.length === 0) return "No files imported.";

  let output = "## Import Results\n\n";
  output += "| Chat | Messages | Imported | Date Range |\n";
  output += "|------|----------|----------|------------|\n";

  let totalFound = 0;
  let totalImported = 0;

  for (const r of results) {
    const oldest = r.date_range.oldest
      ? new Date(r.date_range.oldest * 1000).toISOString().slice(0, 10)
      : "?";
    const newest = r.date_range.newest
      ? new Date(r.date_range.newest * 1000).toISOString().slice(0, 10)
      : "?";

    output += `| ${r.chat_name} | ${r.messages_found} | ${r.messages_imported} | ${oldest} → ${newest} |\n`;
    totalFound += r.messages_found;
    totalImported += r.messages_imported;
  }

  output += `\n**Total:** ${totalImported}/${totalFound} messages imported from ${results.length} chats.`;

  return output;
}
