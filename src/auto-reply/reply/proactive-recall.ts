/**
 * Proactive recall builder — queries Time Tunnel for relevant past conversations
 * and reminders BEFORE the LLM sees the message, injecting them as a context segment.
 *
 * Data source: Time Tunnel SQLite FTS5 search + reminder rules.
 * Pattern: same as warroom-briefing.ts (dynamic import, cache, never throw).
 */

import { existsSync } from "fs";

const TIME_TUNNEL_QUERY_PATH = "/app/workspace/hooks/time-tunnel/query.js";

// Cache to avoid repeated queries for rapid-fire messages
let cached: { text: string; expiresAt: number; key: string } | null = null;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

const MAX_OUTPUT_CHARS = 800;
const MAX_SNIPPET_CHARS = 150;
const MAX_SEARCH_RESULTS = 5;

// ---------------------------------------------------------------------------
// Time Tunnel lazy loader
// ---------------------------------------------------------------------------

interface SearchResult {
  id: number;
  timestamp: string;
  direction: string;
  channel: string;
  chat: string;
  sender: string;
  content: string;
  highlight: string;
}

interface ReminderResult {
  ruleId: number;
  triggerType: string;
  triggerPattern: string;
  actionType: string;
  data: {
    type: string;
    memories?: Array<{ content: string; timestamp: string; sender: string }>;
    knowledge?: Array<{ content: string }>;
    message?: string;
  };
  priority: number;
}

interface TimeTunnelModule {
  search: (query: string, opts?: { person?: string; limit?: number }) => SearchResult[];
  checkReminders: (ctx: { message?: string; sender?: string; chat?: string }) => ReminderResult[];
}

let timeTunnelModule: TimeTunnelModule | null = null;

async function loadTimeTunnel(): Promise<TimeTunnelModule | null> {
  if (timeTunnelModule) return timeTunnelModule;

  try {
    if (!existsSync(TIME_TUNNEL_QUERY_PATH)) return null;

    const mod = await import(TIME_TUNNEL_QUERY_PATH);
    if (typeof mod.search !== "function") return null;

    timeTunnelModule = {
      search: mod.search,
      checkReminders: typeof mod.checkReminders === "function" ? mod.checkReminders : () => [],
    };
    return timeTunnelModule;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Keyword extraction (lightweight, no dependencies)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  // Chinese
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "他",
  "她",
  "它",
  "們",
  "這",
  "那",
  "有",
  "不",
  "會",
  "要",
  "就",
  "也",
  "都",
  "和",
  "跟",
  "嗎",
  "吧",
  "啊",
  "呢",
  "喔",
  "哦",
  "好",
  "對",
  "可以",
  "什麼",
  "怎麼",
  "為什麼",
  "沒有",
  "因為",
  "所以",
  "但是",
  "如果",
  "還是",
  "一個",
  "一下",
  // English
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "can",
  "could",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "this",
  "that",
  "and",
  "or",
  "but",
  "not",
  "no",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "about",
  "what",
  "how",
  "when",
  "where",
  "who",
  "ok",
  "yes",
  "no",
]);

/**
 * Extract meaningful keywords from message text for FTS5 search.
 * Returns up to 5 keywords joined with OR for FTS5 syntax.
 */
export function extractSearchKeywords(text: string): string {
  if (!text || text.length < 2) return "";

  // Split on whitespace and punctuation, keep Chinese characters as individual tokens
  const tokens: string[] = [];

  // Extract Chinese phrases (2-4 char sequences)
  const zhMatches = text.match(/[\u4e00-\u9fff]{2,4}/g);
  if (zhMatches) {
    for (const m of zhMatches) tokens.push(m);
  }

  // Extract English/alphanumeric words
  const enMatches = text.match(/[a-zA-Z0-9]{2,}/gi);
  if (enMatches) {
    for (const m of enMatches) tokens.push(m.toLowerCase());
  }

  // Filter stop words, deduplicate, take top 5
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (STOP_WORDS.has(lower) || seen.has(lower) || lower.length < 2) continue;
    seen.add(lower);
    keywords.push(t);
    if (keywords.length >= 5) break;
  }

  if (keywords.length === 0) return "";

  // FTS5 OR query
  return keywords.join(" OR ");
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (!s || s.length <= max) return s || "";
  return s.slice(0, max) + "...";
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${hour}:${min}`;
  } catch {
    return iso?.slice(0, 16) || "";
  }
}

function formatSearchResults(results: SearchResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const ts = formatTimestamp(r.timestamp);
    const sender = r.sender || "?";
    const content = truncate(r.content, MAX_SNIPPET_CHARS);
    lines.push(`  [${ts}] ${sender}: ${content}`);
  }
  return lines;
}

function formatReminderResults(reminders: ReminderResult[]): string[] {
  const lines: string[] = [];
  for (const r of reminders) {
    if (r.data?.type === "recall" && r.data.memories?.length) {
      lines.push(`  Reminder (${r.triggerPattern}):`);
      for (const m of r.data.memories.slice(0, 3)) {
        const ts = formatTimestamp(m.timestamp);
        const sender = m.sender || "?";
        lines.push(`    [${ts}] ${sender}: ${truncate(m.content, MAX_SNIPPET_CHARS)}`);
      }
    } else if (r.data?.type === "alert" && r.data.message) {
      lines.push(`  Alert: ${truncate(r.data.message, MAX_SNIPPET_CHARS)}`);
    } else if (r.data?.type === "knowledge" && r.data.knowledge?.length) {
      lines.push(`  Knowledge (${r.triggerPattern}):`);
      for (const k of r.data.knowledge.slice(0, 2)) {
        lines.push(`    ${truncate(k.content, MAX_SNIPPET_CHARS)}`);
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a proactive recall context string for injection as a context segment.
 * Queries Time Tunnel FTS5 search + reminder rules for relevant past conversations.
 * Returns empty string if disabled, no data, or on any error.
 */
export async function buildProactiveRecall(
  workspaceDir: string,
  messageBody: string,
  senderName?: string,
  chatName?: string,
): Promise<string> {
  // Cache check
  const cacheKey = `${senderName || ""}:${messageBody.slice(0, 50)}`;
  if (cached && Date.now() < cached.expiresAt && cached.key === cacheKey) {
    return cached.text;
  }

  try {
    const mod = await loadTimeTunnel();
    if (!mod) return "";

    const searchQuery = extractSearchKeywords(messageBody);
    if (!searchQuery) return "";

    // FTS5 search — fast, no side effects
    const searchResults = mod.search(searchQuery, {
      person: senderName,
      limit: MAX_SEARCH_RESULTS,
    });

    // Reminder rules check
    let reminders: ReminderResult[] = [];
    try {
      reminders = mod.checkReminders({
        message: messageBody,
        sender: senderName,
        chat: chatName,
      });
    } catch {
      // checkReminders may fail if reminder_rules table doesn't exist — that's fine
    }

    const hasSearch = searchResults.length > 0;
    const hasReminders = reminders.length > 0;

    if (!hasSearch && !hasReminders) return "";

    // Build output
    const lines: string[] = ["[Recall — related history for context]"];

    if (hasSearch) {
      lines.push("Past conversations:");
      lines.push(...formatSearchResults(searchResults));
    }

    if (hasReminders) {
      if (hasSearch) lines.push("");
      lines.push("Triggered reminders:");
      lines.push(...formatReminderResults(reminders));
    }

    lines.push("[/Recall]");

    let text = lines.join("\n");
    // Enforce total length limit
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS - 12) + "\n[/Recall]";
    }

    // Cache
    cached = { text, expiresAt: Date.now() + CACHE_TTL_MS, key: cacheKey };

    return text;
  } catch {
    return "";
  }
}

/** Exposed for testing. */
export function _clearCache(): void {
  cached = null;
}
