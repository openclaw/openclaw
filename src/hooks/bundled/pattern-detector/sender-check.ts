/**
 * sender-check.ts — Sender Check + Context Briefing
 *
 * Detects when the message sender is NOT the owner and injects
 * identity context + conversation briefing into the prompt.
 *
 * All functions are exported for testability.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../../../config/sessions/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type {
  PluginHookBeforeAgentStartEvent,
  PluginHookAgentContext,
} from "../../../plugins/types.js";
import type { SenderCheckConfig } from "./handler.js";

const log = createSubsystemLogger("hooks/sender-check");

// ============================================================================
// UTF-8 encoding utilities
// ============================================================================

/**
 * CP1252 special range (0x80–0x9F): maps Unicode code point → CP1252 byte.
 * These are the characters that CP1252 defines differently from Latin-1.
 */
const CP1252_EXTRAS: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/**
 * Attempt one pass of CP1252 double-encoding reversal.
 * Returns decoded string, or null if the input is not CP1252-encoded mojibake
 * (i.e. contains code points outside the CP1252 range).
 */
function tryFixMojibake(s: string): string | null {
  const bytes: number[] = [];
  for (const char of s) {
    const cp = char.codePointAt(0)!;
    if (cp <= 0x7f) {
      bytes.push(cp);
    } else if (CP1252_EXTRAS[cp] !== undefined) {
      bytes.push(CP1252_EXTRAS[cp]);
    } else if (cp <= 0xff) {
      bytes.push(cp);
    } else {
      return null; // code point outside CP1252 → string is valid UTF-8, not mojibake
    }
  }
  const decoded = Buffer.from(bytes).toString("utf-8");
  return decoded.includes("\uFFFD") ? null : decoded;
}

/**
 * Detect and reverse CP1252 double-encoding (mojibake) in a config string.
 * Iteratively applies the decode until the string stabilises or a non-CP1252
 * character is found (meaning the string is already valid UTF-8).
 * Safe to call on already-correct strings — they pass through unchanged.
 */
export function fixMojibakeIfNeeded(str: string): string {
  let cur = str;
  for (let i = 0; i < 5; i++) {
    const next = tryFixMojibake(cur);
    if (next === null || next === cur) {
      return cur;
    }
    cur = next;
  }
  return cur;
}

// ============================================================================
// Debounce (sliding window, per sender+session)
// ============================================================================

const SENDER_DEBOUNCE_FILE = "sender-check-debounce.json";

/**
 * Maps debounceKey → timestamp of last message received.
 * debounceKey = "senderE164::sessionKey" for per-chat debounce.
 */
type SenderDebounceMap = Record<string, number>;

export function loadSenderDebounce(agentId?: string): SenderDebounceMap {
  try {
    const dir = resolveSessionTranscriptsDirForAgent(agentId);
    const file = path.join(dir, SENDER_DEBOUNCE_FILE);
    if (!fs.existsSync(file)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

export function saveSenderDebounce(agentId: string | undefined, debounce: SenderDebounceMap): void {
  try {
    const dir = resolveSessionTranscriptsDirForAgent(agentId);
    const file = path.join(dir, SENDER_DEBOUNCE_FILE);
    fs.writeFileSync(file, JSON.stringify(debounce));
  } catch {
    // silent — debounce persistence failure is non-critical
  }
}

/**
 * Build debounce key from sender + session context.
 * Per-chat debounce: Caio in DM and Caio in group are independent.
 */
export function buildDebounceKey(senderE164: string, sessionKey?: string): string {
  return sessionKey ? `${senderE164}::${sessionKey}` : senderE164;
}

/**
 * Check if a sender alert should fire.
 * Returns true if we should inject the alert (first msg or gap > debounceMinutes).
 * Always records the current timestamp (sliding window: timer resets).
 */
export function shouldAlertSender(
  senderE164: string,
  debounceMinutes: number,
  agentId?: string,
  sessionKey?: string,
): boolean {
  const debounce = loadSenderDebounce(agentId);
  const now = Date.now();
  const key = buildDebounceKey(senderE164, sessionKey);
  const lastSeen = debounce[key];
  const windowMs = debounceMinutes * 60 * 1000;

  // Always update the timestamp (sliding window)
  debounce[key] = now;

  // Prune entries older than 2x the window to prevent unbounded growth
  for (const k of Object.keys(debounce)) {
    if (now - debounce[k] > windowMs * 2) {
      delete debounce[k];
    }
  }

  saveSenderDebounce(agentId, debounce);

  // First message ever from this sender in this chat → alert
  if (lastSeen === undefined) {
    return true;
  }

  // Gap since last message > window → alert
  if (now - lastSeen > windowMs) {
    return true;
  }

  // Still within debounce window → suppress
  return false;
}

// ============================================================================
// Briefing Loader (JSON pré-processado)
// ============================================================================

export type ContactBriefing = {
  name: string;
  slug: string;
  relation: string | null;
  lastDate: string | null;
  lastTopic: string | null;
  accessRules: string | null;
  sensitiveNotes: string | null;
};

type BriefingFile = Record<string, ContactBriefing> & {
  _generated?: string;
  _version?: number;
};

// In-memory cache with TTL
let briefingCache: { data: BriefingFile; loadedAt: number } | null = null;
const BRIEFING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Load the contacts-briefing.json file with in-memory caching (5 min TTL).
 * Falls back to empty object if file doesn't exist.
 */
export function loadBriefing(workspaceDir: string, briefingFile: string): BriefingFile {
  const now = Date.now();
  if (briefingCache && now - briefingCache.loadedAt < BRIEFING_CACHE_TTL_MS) {
    return briefingCache.data;
  }

  try {
    const filePath = path.isAbsolute(briefingFile)
      ? briefingFile
      : path.resolve(workspaceDir, briefingFile);
    log.debug(`[sender-check] briefing path: ${filePath} (exists: ${fs.existsSync(filePath)})`);
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw) as BriefingFile;
    briefingCache = { data, loadedAt: now };
    return data;
  } catch (err) {
    log.warn(`Failed to read briefing file: ${String(err)}`);
    return {};
  }
}

/**
 * Clear the briefing cache (for testing).
 */
export function clearBriefingCache(): void {
  briefingCache = null;
}

// ============================================================================
// Build Sender Briefing String
// ============================================================================

/**
 * Build a rich briefing string for a known contact using the knownTemplate.
 * Replaces placeholders with contact data from contacts-briefing.json.
 * Respects maxChars limit.
 *
 * Supported placeholders:
 *   {{senderNumber}}, {{senderName}}, {{senderRelation}},
 *   {{lastDate}}, {{lastTopic}}, {{accessRules}}, {{sensitiveNotes}}
 */
export function buildSenderBriefing(
  contact: ContactBriefing,
  senderE164: string,
  knownTemplate: string,
  maxChars: number,
): string {
  let result = knownTemplate;
  result = result.replace(/\{\{senderNumber\}\}/g, senderE164);
  result = result.replace(/\{\{senderName\}\}/g, contact.name ?? "Desconhecido");
  result = result.replace(/\{\{senderRelation\}\}/g, contact.relation ?? "Não informado");
  result = result.replace(/\{\{lastDate\}\}/g, contact.lastDate ?? "sem data");
  result = result.replace(/\{\{lastTopic\}\}/g, contact.lastTopic ?? "sem histórico");
  result = result.replace(/\{\{accessRules\}\}/g, contact.accessRules ?? "sem regras definidas");
  result = result.replace(/\{\{sensitiveNotes\}\}/g, contact.sensitiveNotes ?? "");
  // Remove empty lines left by null placeholders
  result = result.replace(/\n\s*\n/g, "\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 15) + "\n[...truncated]";
  }
  return result;
}

// ============================================================================
// E.164 Validation
// ============================================================================

const E164_RE = /^\+\d{10,15}$/;

/**
 * Validate that a string looks like an E.164 phone number.
 */
export function isValidE164(num: string): boolean {
  return E164_RE.test(num.replace(/[\s\-().]/g, ""));
}

// ============================================================================
// Main: runSenderCheck
// ============================================================================

/**
 * Run the sender check logic.
 * Returns an alert string to prepend to the prompt, or null if no alert needed.
 */
export function runSenderCheck(
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
  senderCheckConfig: SenderCheckConfig,
): string | null {
  if (!senderCheckConfig.enabled) {
    return null;
  }

  // Reverse CP1252 double-encoding that may come from config files edited on Windows
  const knownTemplate = fixMojibakeIfNeeded(senderCheckConfig.knownTemplate);
  const unknownTemplate = fixMojibakeIfNeeded(senderCheckConfig.unknownTemplate);

  const sender = event.senderMetadata;
  if (!sender?.senderE164) {
    // If senderIsOwner is explicitly false (determined by command-auth upstream),
    // we know it's a real non-owner message without E.164 (e.g. group LID).
    // But only if there's actual sender context (name or chatType) — otherwise
    // it's a system trigger (heartbeat/cron) that sets senderIsOwner:false without
    // a real person behind it.
    if (sender?.senderIsOwner === false && (sender.senderName || sender.chatType)) {
      const name = sender.senderName ?? "Desconhecido";
      let alert = unknownTemplate;
      alert = alert.replace(/\{\{senderNumber\}\}/g, "sem número");
      alert = alert.replace(/\{\{senderName\}\}/g, name);
      log.info(`Sender check: non-owner without E.164 (name=${name})`);
      return alert;
    }
    // senderIsOwner undefined = heartbeat or trigger without real sender
    log.debug("Sender check: no senderE164 (likely heartbeat), skipping");
    return null;
  }

  const senderE164 = sender.senderE164;

  // Check if sender is owner (OR-logic: senderIsOwner flag OR number in ownerNumbers)
  const normalizedSender = senderE164.replace(/[\s\-().]/g, "");
  const isOwner =
    sender.senderIsOwner === true ||
    senderCheckConfig.ownerNumbers.some(
      (ownerNum) => ownerNum.replace(/[\s\-().]/g, "") === normalizedSender,
    );

  if (isOwner) {
    log.debug(`Sender check: ${senderE164} is owner, skipping`);
    return null;
  }

  // Debounce check (sliding window, per sender+session)
  const shouldAlert = shouldAlertSender(
    senderE164,
    senderCheckConfig.debounceMinutes,
    ctx.agentId,
    sender.sessionKey,
  );

  if (!shouldAlert) {
    log.debug(`Sender check: ${senderE164} suppressed by debounce`);
    return null;
  }

  // Load briefing from JSON
  const workspaceDir = ctx.workspaceDir ?? process.cwd();
  const briefing = loadBriefing(workspaceDir, senderCheckConfig.briefingFile);
  const contact = briefing[senderE164] as ContactBriefing | undefined;

  if (contact && typeof contact === "object" && "name" in contact) {
    // Known contact — build rich briefing from knownTemplate
    const alert = buildSenderBriefing(
      contact,
      senderE164,
      knownTemplate,
      senderCheckConfig.maxBriefingChars,
    );
    log.info(`Sender check: non-owner ${senderE164} identified as ${contact.name}`);
    return alert;
  } else {
    // Unknown contact — use template with placeholder substitution
    let alert = unknownTemplate;
    alert = alert.replace(/\{\{senderNumber\}\}/g, senderE164);
    alert = alert.replace(/\{\{senderName\}\}/g, sender.senderName ?? "Desconhecido");
    log.info(`Sender check: unknown non-owner ${senderE164}`);
    return alert;
  }
}
