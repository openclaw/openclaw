/**
 * Cross-channel content forwarding.
 *
 * Detects X/Twitter URLs in inbound messages, classifies content,
 * and forwards to the appropriate agent's Zulip stream instead of
 * replying inline in the source channel.
 */
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { withFileLock, type FileLockOptions } from "../../plugin-sdk/file-lock.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { RecognizedContentRouteResult } from "./content-route.js";

export type ResolvedContentForwardConfig = {
  enabled: boolean;
  channel: string;
  streams: Record<string, string>;
  streamPattern: string;
  topicPrefix: string;
};

const DEFAULT_CHANNEL = "zulip";
const DEFAULT_STREAM_PATTERN = "{agent}";
const DEFAULT_TOPIC_PREFIX = "x";
// Zulip topic limit is 60 chars.
const ZULIP_TOPIC_MAX = 60;

/**
 * Strip characters that Zulip rejects in topic names:
 * control chars (C0/C1), zero-width chars, and other invisible/unassigned codepoints.
 */
function sanitizeZulipTopic(topic: string): string {
  // Remove control characters (U+0000–U+001F, U+007F–U+009F), zero-width
  // spaces/joiners, and other problematic Unicode (direction marks, etc.).
  let sanitized = "";
  for (const char of topic) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const isControl =
      (codePoint >= 0x0000 && codePoint <= 0x001f) || (codePoint >= 0x007f && codePoint <= 0x009f);
    const isZeroWidthOrDirectional =
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202f) ||
      codePoint === 0x2060 ||
      codePoint === 0xfeff;
    const isNoncharacter = codePoint >= 0xfff0 && codePoint <= 0xffff;
    if (isControl || isZeroWidthOrDirectional || isNoncharacter) {
      continue;
    }
    sanitized += char;
  }
  return sanitized.trim();
}

/**
 * Resolve the content forward config from OpenClawConfig.
 * Returns null if forwarding is not configured or disabled.
 */
export function resolveContentForwardConfig(
  cfg: OpenClawConfig,
): ResolvedContentForwardConfig | null {
  const fwd = cfg.agents?.contentRouting?.forward;
  if (!fwd?.enabled) {
    return null;
  }
  return {
    enabled: true,
    channel: fwd.channel?.trim() || DEFAULT_CHANNEL,
    streams: fwd.streams ?? {},
    streamPattern: fwd.streamPattern?.trim() || DEFAULT_STREAM_PATTERN,
    topicPrefix: fwd.topicPrefix?.trim() || DEFAULT_TOPIC_PREFIX,
  };
}

/**
 * Build the Zulip delivery target string for a forwarded post.
 *
 * Returns e.g. `{ channel: "zulip", to: "stream:liev:topic:x: best supplements" }`
 */
export function buildForwardTarget(params: {
  config: ResolvedContentForwardConfig;
  agentId: string;
  category?: string;
  topicSuffix: string;
  topicPrefix?: string;
}): { channel: string; to: string } {
  // Category-aware stream lookup: "agent:category" → "agent" → streamPattern.
  const stream =
    (params.category && params.config.streams[`${params.agentId}:${params.category}`]) ??
    params.config.streams[params.agentId] ??
    params.config.streamPattern.replace("{agent}", params.agentId);
  const prefix = params.topicPrefix ?? params.config.topicPrefix;

  // Build topic: "prefix: suffix", truncated to Zulip's 60-char limit.
  // Sanitize to remove chars Zulip rejects (control chars, zero-width, etc.).
  const separator = ": ";
  const maxSuffixLen = ZULIP_TOPIC_MAX - prefix.length - separator.length;
  const rawSuffix =
    maxSuffixLen > 0 ? truncateUtf16Safe(params.topicSuffix.trim(), maxSuffixLen) : "";
  const suffix = sanitizeZulipTopic(rawSuffix);
  const topic = sanitizeZulipTopic(suffix ? `${prefix}${separator}${suffix}` : prefix);

  return {
    channel: params.config.channel,
    to: `stream:${stream}:topic:${topic}`,
  };
}

/**
 * Format the Zulip message body for a forwarded tweet.
 */
export function formatForwardBody(params: {
  tweetText: string;
  tweetUrl: string;
  tweetAuthor?: string;
  classification: RecognizedContentRouteResult;
}): string {
  const lines: string[] = [];
  if (params.tweetAuthor) {
    lines.push(`**@${params.tweetAuthor}**`);
  }
  lines.push(params.tweetText);
  lines.push("");
  lines.push(params.tweetUrl);
  lines.push("");
  lines.push(formatRoutingSummary(params.classification));
  return lines.join("\n");
}

/**
 * Format the Zulip message body for any forwarded content (general intake).
 */
export function formatGeneralForwardBody(params: {
  text: string;
  mediaType?: string;
  classification: RecognizedContentRouteResult;
}): string {
  const lines: string[] = [];
  if (params.mediaType) {
    lines.push(`📎 *${params.mediaType}*`);
  }
  if (params.text) {
    lines.push(params.text);
  }
  lines.push("");
  lines.push(formatRoutingSummary(params.classification));
  return lines.join("\n");
}

function formatRoutingSummary(classification: RecognizedContentRouteResult): string {
  const routedTarget = classification.category
    ? `${classification.agentId}:${classification.category}`
    : classification.agentId;
  return `*Routed to ${routedTarget}*`;
}

function extractNonUrlContextText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>)"']+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTweetTopicText(tweetText: string): string {
  const compact = tweetText.replace(/\s+/g, " ").trim();
  const withoutAuthor = compact.replace(/^@[^\s:]+(?:\s*\([^)]*\))?:\s*/u, "");
  const withoutLeadingNoise = withoutAuthor.replace(/^[>\-–—:;.,!?\s]+/u, "").trim();
  return withoutLeadingNoise || compact;
}

/**
 * Build a topic suffix based on content type.
 * - Tweet URL + user note: use the user's note/question
 * - Tweet URL only: cleaned tweet summary
 * - Other URL: "link: <domain>"
 * - Photo + text: text summary
 * - Photo only: "photo: <date>"
 * - Text only: first ~50 chars
 */
export function buildTopicSuffix(params: {
  text: string;
  mediaType?: string;
  tweetText?: string;
}): { suffix: string; prefix?: string } {
  const text = params.text.trim();
  const nonUrlContext = extractNonUrlContextText(text);

  if (params.tweetText) {
    if (nonUrlContext && !nonUrlContext.startsWith("<media:")) {
      return { suffix: nonUrlContext };
    }
    return { suffix: normalizeTweetTopicText(params.tweetText) };
  }

  // URL content (non-tweet): extract domain
  const urlMatch = text.match(/https?:\/\/([^/\s]+)/);
  if (urlMatch) {
    const domain = urlMatch[1];
    return {
      suffix: nonUrlContext ? nonUrlContext.slice(0, 40) : domain,
      prefix: "link",
    };
  }

  // Photo only (no text or just a placeholder)
  if (params.mediaType && (!text || text.startsWith("<media:"))) {
    const date = new Date().toISOString().slice(5, 10); // MM-DD
    return { suffix: date, prefix: "photo" };
  }

  // Text content: first ~50 chars
  if (text && !text.startsWith("<media:")) {
    return { suffix: text.slice(0, 50) };
  }

  return { suffix: new Date().toISOString().slice(0, 10) };
}

/**
 * Build a Zulip narrow link for the given stream and topic.
 * Returns empty string if no baseUrl is provided.
 */
function buildZulipNarrowLink(params: {
  baseUrl?: string;
  stream: string;
  topic?: string;
  messageId?: string | number;
}): string {
  if (!params.baseUrl) {
    return "";
  }
  const base = params.baseUrl.replace(/\/+$/, "");
  if (params.messageId !== undefined && params.messageId !== null && `${params.messageId}`.trim()) {
    return `${base}/#narrow/near/${encodeURIComponent(String(params.messageId))}`;
  }
  const stream = encodeURIComponent(params.stream);
  if (!params.topic) {
    return `${base}/#narrow/stream/${stream}`;
  }
  const topic = encodeURIComponent(params.topic);
  return `${base}/#narrow/stream/${stream}/topic/${topic}`;
}

/**
 * Format the short iMessage acknowledgement.
 * Returns e.g. "→ liev #liev\ntopic\nhttps://..."
 */
export function formatForwardAck(params: {
  agentId: string;
  stream: string;
  topic?: string;
  zulipBaseUrl?: string;
  zulipMessageId?: string | number;
}): string {
  const base = `→ ${params.agentId} #${params.stream}`;
  const link = buildZulipNarrowLink({
    baseUrl: params.zulipBaseUrl,
    stream: params.stream,
    topic: params.topic,
    messageId: params.zulipMessageId,
  });
  const parts = [base];
  if (params.topic) {
    parts.push(params.topic);
  }
  if (link) {
    parts.push(link);
  }
  return parts.join("\n");
}

// --- Follow-up tracking: detect messages that continue a previous forward. ---

const DEFAULT_FOLLOWUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_RECENT_TWEET_FORWARD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECENT_TWEET_FORWARD_STORE_FILE = "cache/content-forward-recent-tweets.json";
const RECENT_TWEET_FORWARD_STORE_LOCK: FileLockOptions = {
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
  stale: 60_000,
};

export type LastForwardEntry = {
  channel: string;
  to: string;
  agentId: string;
  stream: string;
  messageId?: string;
  tweetId?: string;
  tweetText?: string;
  category?: string;
  timestamp: number;
};

type RecentTweetForwardStore = Record<string, LastForwardEntry>;

/** In-memory cache of last forward per sender. */
const lastForwardByPeer = new Map<string, LastForwardEntry>();
/** In-memory cache of recent X/Twitter forwards by sender + tweet id. */
const recentTweetForwardByKey = new Map<string, LastForwardEntry>();

function buildRecentTweetForwardKey(peer: string, tweetId: string): string {
  return `${peer.trim().toLowerCase()}|${tweetId.trim()}`;
}

function resolveRecentTweetForwardStorePath(): string {
  return path.join(resolveStateDir(), RECENT_TWEET_FORWARD_STORE_FILE);
}

function sanitizeLastForwardEntry(value: unknown): LastForwardEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.channel !== "string" ||
    typeof candidate.to !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.stream !== "string" ||
    typeof candidate.timestamp !== "number" ||
    !Number.isFinite(candidate.timestamp)
  ) {
    return null;
  }
  const entry: LastForwardEntry = {
    channel: candidate.channel,
    to: candidate.to,
    agentId: candidate.agentId,
    stream: candidate.stream,
    timestamp: candidate.timestamp,
  };
  if (typeof candidate.messageId === "string" && candidate.messageId.trim()) {
    entry.messageId = candidate.messageId;
  }
  if (typeof candidate.tweetId === "string" && candidate.tweetId.trim()) {
    entry.tweetId = candidate.tweetId;
  }
  if (typeof candidate.tweetText === "string" && candidate.tweetText.trim()) {
    entry.tweetText = candidate.tweetText;
  }
  if (typeof candidate.category === "string" && candidate.category.trim()) {
    entry.category = candidate.category;
  }
  return entry;
}

function sanitizeRecentTweetForwardStore(value: unknown): RecentTweetForwardStore {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: RecentTweetForwardStore = {};
  for (const [key, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const entry = sanitizeLastForwardEntry(rawEntry);
    if (entry) {
      out[key] = entry;
    }
  }
  return out;
}

function pruneRecentTweetForwardStore(
  store: RecentTweetForwardStore,
  ttlMs: number,
  now: number,
): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(store)) {
    if (ttlMs > 0 && now - entry.timestamp >= ttlMs) {
      delete store[key];
      recentTweetForwardByKey.delete(key);
      changed = true;
    }
  }
  return changed;
}

async function withRecentTweetForwardStore<T>(
  task: (
    store: RecentTweetForwardStore,
  ) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean },
): Promise<T> {
  const storePath = resolveRecentTweetForwardStorePath();
  return await withFileLock(storePath, RECENT_TWEET_FORWARD_STORE_LOCK, async () => {
    const { value } = await readJsonFileWithFallback<RecentTweetForwardStore>(storePath, {});
    const store = sanitizeRecentTweetForwardStore(value);
    const pruned = pruneRecentTweetForwardStore(
      store,
      DEFAULT_RECENT_TWEET_FORWARD_TTL_MS,
      Date.now(),
    );
    const { result, changed } = await task(store);
    if (pruned || changed) {
      await writeJsonFileAtomically(storePath, store);
    }
    return result;
  });
}

/** Record a forward so follow-ups from the same sender can be detected. */
export function recordLastForward(peer: string, entry: LastForwardEntry): void {
  lastForwardByPeer.set(peer, entry);
}

/**
 * Check if a recent forward exists for this sender within the TTL window.
 * Returns the entry if found and still fresh, null otherwise.
 */
export function getLastForward(
  peer: string,
  ttlMs: number = DEFAULT_FOLLOWUP_TTL_MS,
): LastForwardEntry | null {
  const entry = lastForwardByPeer.get(peer);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.timestamp > ttlMs) {
    lastForwardByPeer.delete(peer);
    return null;
  }
  return entry;
}

/** Clear a peer's last forward (e.g. after explicit topic change). */
export function clearLastForward(peer: string): void {
  lastForwardByPeer.delete(peer);
}

/** Record a recent X/Twitter forward so duplicate links can reuse the same thread. */
export async function recordRecentTweetForward(
  peer: string,
  tweetId: string,
  entry: LastForwardEntry,
): Promise<void> {
  if (!peer.trim() || !tweetId.trim()) {
    return;
  }
  const key = buildRecentTweetForwardKey(peer, tweetId);
  recentTweetForwardByKey.set(key, entry);
  await withRecentTweetForwardStore(async (store) => {
    store[key] = entry;
    return { result: undefined, changed: true };
  });
}

/**
 * Check whether this sender already forwarded the same tweet recently.
 * Returns the cached entry if still fresh, null otherwise.
 */
export async function getRecentTweetForward(
  peer: string,
  tweetId: string,
  ttlMs: number = DEFAULT_RECENT_TWEET_FORWARD_TTL_MS,
): Promise<LastForwardEntry | null> {
  if (!peer.trim() || !tweetId.trim()) {
    return null;
  }
  const key = buildRecentTweetForwardKey(peer, tweetId);
  const memoryEntry = recentTweetForwardByKey.get(key);
  if (memoryEntry) {
    if (ttlMs > 0 && Date.now() - memoryEntry.timestamp >= ttlMs) {
      recentTweetForwardByKey.delete(key);
    } else {
      return memoryEntry;
    }
  }
  return await withRecentTweetForwardStore(async (store) => {
    let changed = pruneRecentTweetForwardStore(store, ttlMs, Date.now());
    const entry = store[key];
    if (!entry) {
      return { result: null, changed };
    }
    if (ttlMs > 0 && Date.now() - entry.timestamp >= ttlMs) {
      delete store[key];
      recentTweetForwardByKey.delete(key);
      changed = true;
      return { result: null, changed };
    }
    recentTweetForwardByKey.set(key, entry);
    return { result: entry, changed };
  });
}

/** Clear a sender+tweet recent-forward entry. */
export async function clearRecentTweetForward(peer: string, tweetId: string): Promise<void> {
  if (!peer.trim() || !tweetId.trim()) {
    return;
  }
  const key = buildRecentTweetForwardKey(peer, tweetId);
  recentTweetForwardByKey.delete(key);
  await withRecentTweetForwardStore(async (store) => {
    if (!(key in store)) {
      return { result: undefined, changed: false };
    }
    delete store[key];
    return { result: undefined, changed: true };
  });
}
