import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { capArrayByJsonBytes } from "../../gateway/session-utils.fs.js";
import { isAcpSessionKey, normalizeMainKey } from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import { sanitizeUserFacingText } from "../pi-embedded-helpers.js";
import {
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
  stripThinkingTagsFromText,
} from "../pi-embedded-utils.js";

export type SessionKind = "main" | "group" | "cron" | "hook" | "node" | "other";

export const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;
const SESSIONS_HISTORY_TEXT_TRUNCATED_SUFFIX = "\n…(truncated)…";

export type SessionListDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export type SessionListRow = {
  key: string;
  kind: SessionKind;
  channel: string;
  label?: string;
  displayName?: string;
  deliveryContext?: SessionListDeliveryContext;
  updatedAt?: number | null;
  sessionId?: string;
  model?: string;
  contextTokens?: number | null;
  totalTokens?: number | null;
  thinkingLevel?: string;
  verboseLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  sendPolicy?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  transcriptPath?: string;
  messages?: unknown[];
};

function normalizeKey(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveMainSessionAlias(cfg: OpenClawConfig) {
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const alias = scope === "global" ? "global" : mainKey;
  return { mainKey, alias, scope };
}

export function resolveDisplaySessionKey(params: { key: string; alias: string; mainKey: string }) {
  if (params.key === params.alias) {
    return "main";
  }
  if (params.key === params.mainKey) {
    return "main";
  }
  return params.key;
}

export function resolveInternalSessionKey(params: { key: string; alias: string; mainKey: string }) {
  if (params.key === "main") {
    return params.alias;
  }
  return params.key;
}

export type AgentToAgentPolicy = {
  enabled: boolean;
  matchesAllow: (agentId: string) => boolean;
  isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};

export function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy {
  const routingA2A = cfg.tools?.agentToAgent;
  const enabled = routingA2A?.enabled === true;
  const allowPatterns = Array.isArray(routingA2A?.allow) ? routingA2A.allow : [];
  const matchesAllow = (agentId: string) => {
    if (allowPatterns.length === 0) {
      return true;
    }
    return allowPatterns.some((pattern) => {
      const raw = String(pattern ?? "").trim();
      if (!raw) {
        return false;
      }
      if (raw === "*") {
        return true;
      }
      if (!raw.includes("*")) {
        return raw === agentId;
      }
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`, "i");
      return re.test(agentId);
    });
  };
  const isAllowed = (requesterAgentId: string, targetAgentId: string) => {
    if (requesterAgentId === targetAgentId) {
      return true;
    }
    if (!enabled) {
      return false;
    }
    return matchesAllow(requesterAgentId) && matchesAllow(targetAgentId);
  };
  return { enabled, matchesAllow, isAllowed };
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value.trim());
}

export function looksLikeSessionKey(value: string): boolean {
  const raw = value.trim();
  if (!raw) {
    return false;
  }
  // These are canonical key shapes that should never be treated as sessionIds.
  if (raw === "main" || raw === "global" || raw === "unknown") {
    return true;
  }
  if (isAcpSessionKey(raw)) {
    return true;
  }
  if (raw.startsWith("agent:")) {
    return true;
  }
  if (raw.startsWith("cron:") || raw.startsWith("hook:")) {
    return true;
  }
  if (raw.startsWith("node-") || raw.startsWith("node:")) {
    return true;
  }
  if (raw.includes(":group:") || raw.includes(":channel:")) {
    return true;
  }
  return false;
}

export function shouldResolveSessionIdInput(value: string): boolean {
  // Treat anything that doesn't look like a well-formed key as a sessionId candidate.
  return looksLikeSessionId(value) || !looksLikeSessionKey(value);
}

export type SessionReferenceResolution =
  | {
      ok: true;
      key: string;
      displayKey: string;
      resolvedViaSessionId: boolean;
    }
  | { ok: false; status: "error" | "forbidden"; error: string };

async function resolveSessionKeyFromSessionId(params: {
  sessionId: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution> {
  try {
    // Resolve via gateway so we respect store routing and visibility rules.
    const result = await callGateway<{ key?: string }>({
      method: "sessions.resolve",
      params: {
        sessionId: params.sessionId,
        spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
        includeGlobal: !params.restrictToSpawned,
        includeUnknown: !params.restrictToSpawned,
      },
    });
    const key = typeof result?.key === "string" ? result.key.trim() : "";
    if (!key) {
      throw new Error(
        `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
      );
    }
    return {
      ok: true,
      key,
      displayKey: resolveDisplaySessionKey({
        key,
        alias: params.alias,
        mainKey: params.mainKey,
      }),
      resolvedViaSessionId: true,
    };
  } catch (err) {
    if (params.restrictToSpawned) {
      return {
        ok: false,
        status: "forbidden",
        error: `Session not visible from this sandboxed agent session: ${params.sessionId}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: "error",
      error:
        message ||
        `Session not found: ${params.sessionId} (use the full sessionKey from sessions_list)`,
    };
  }
}

async function resolveSessionKeyFromKey(params: {
  key: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution | null> {
  try {
    // Try key-based resolution first so non-standard keys keep working.
    const result = await callGateway<{ key?: string }>({
      method: "sessions.resolve",
      params: {
        key: params.key,
        spawnedBy: params.restrictToSpawned ? params.requesterInternalKey : undefined,
      },
    });
    const key = typeof result?.key === "string" ? result.key.trim() : "";
    if (!key) {
      return null;
    }
    return {
      ok: true,
      key,
      displayKey: resolveDisplaySessionKey({
        key,
        alias: params.alias,
        mainKey: params.mainKey,
      }),
      resolvedViaSessionId: false,
    };
  } catch {
    return null;
  }
}

export async function resolveSessionReference(params: {
  sessionKey: string;
  alias: string;
  mainKey: string;
  requesterInternalKey?: string;
  restrictToSpawned: boolean;
}): Promise<SessionReferenceResolution> {
  const raw = params.sessionKey.trim();
  if (shouldResolveSessionIdInput(raw)) {
    // Prefer key resolution to avoid misclassifying custom keys as sessionIds.
    const resolvedByKey = await resolveSessionKeyFromKey({
      key: raw,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
    });
    if (resolvedByKey) {
      return resolvedByKey;
    }
    return await resolveSessionKeyFromSessionId({
      sessionId: raw,
      alias: params.alias,
      mainKey: params.mainKey,
      requesterInternalKey: params.requesterInternalKey,
      restrictToSpawned: params.restrictToSpawned,
    });
  }

  const resolvedKey = resolveInternalSessionKey({
    key: raw,
    alias: params.alias,
    mainKey: params.mainKey,
  });
  const displayKey = resolveDisplaySessionKey({
    key: resolvedKey,
    alias: params.alias,
    mainKey: params.mainKey,
  });
  return { ok: true, key: resolvedKey, displayKey, resolvedViaSessionId: false };
}

export function classifySessionKind(params: {
  key: string;
  gatewayKind?: string | null;
  alias: string;
  mainKey: string;
}): SessionKind {
  const key = params.key;
  if (key === params.alias || key === params.mainKey) {
    return "main";
  }
  if (key.startsWith("cron:")) {
    return "cron";
  }
  if (key.startsWith("hook:")) {
    return "hook";
  }
  if (key.startsWith("node-") || key.startsWith("node:")) {
    return "node";
  }
  if (params.gatewayKind === "group") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "other";
}

export function deriveChannel(params: {
  key: string;
  kind: SessionKind;
  channel?: string | null;
  lastChannel?: string | null;
}): string {
  if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") {
    return "internal";
  }
  const channel = normalizeKey(params.channel ?? undefined);
  if (channel) {
    return channel;
  }
  const lastChannel = normalizeKey(params.lastChannel ?? undefined);
  if (lastChannel) {
    return lastChannel;
  }
  const parts = params.key.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return parts[0];
  }
  return "unknown";
}

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.filter((msg) => {
    if (!msg || typeof msg !== "object") {
      return true;
    }
    const role = (msg as { role?: unknown }).role;
    return role !== "toolResult";
  });
}

function truncateHistoryText(text: string): { text: string; truncated: boolean } {
  if (text.length <= SESSIONS_HISTORY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }
  // Keep the *final* string (including the suffix) within the hard cap.
  const maxPrefixChars = Math.max(
    0,
    SESSIONS_HISTORY_TEXT_MAX_CHARS - SESSIONS_HISTORY_TEXT_TRUNCATED_SUFFIX.length,
  );
  const cut = truncateUtf16Safe(text, maxPrefixChars);
  return { text: `${cut}${SESSIONS_HISTORY_TEXT_TRUNCATED_SUFFIX}`, truncated: true };
}

function sanitizeHistoryContentBlock(params: { block: unknown; includeThinking: boolean }): {
  block: unknown;
  truncated: boolean;
} {
  const block = params.block;
  if (!block || typeof block !== "object") {
    return { block, truncated: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let truncated = false;
  const type = typeof entry.type === "string" ? entry.type : "";

  const hasThinkingSignature = "thinkingSignature" in entry;
  if (!params.includeThinking && (type === "thinking" || hasThinkingSignature)) {
    // Thinking blocks (and thinking-like blocks) can contain large encrypted signatures; omit by default.
    // This is policy-based omission, not "truncation due to size limits".
    return { block: null, truncated: false };
  }

  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
  }
  if (type === "thinking") {
    if (typeof entry.thinking === "string") {
      const res = truncateHistoryText(entry.thinking);
      entry.thinking = res.text;
      truncated ||= res.truncated;
    }
  }
  // The encrypted signature can be extremely large and is not useful for history recall.
  // Strip it regardless of block type so minor schema drift can't leak it.
  if (hasThinkingSignature) {
    delete entry.thinkingSignature;
    truncated = true;
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    truncated ||= res.truncated;
  }
  if (type === "image") {
    const data = typeof entry.data === "string" ? entry.data : undefined;
    if (data !== undefined) {
      const bytes = Buffer.byteLength(data, "utf8");
      delete entry.data;
      entry.omitted = true;
      entry.bytes = bytes;
      truncated = true;
    }
  }
  return { block: entry, truncated };
}

function sanitizeHistoryMessage(params: { message: unknown; includeThinking: boolean }): {
  message: unknown;
  truncated: boolean;
} {
  const message = params.message;
  if (!message || typeof message !== "object") {
    return { message, truncated: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let truncated = false;

  // Tool result details often contain very large nested payloads.
  if ("details" in entry) {
    delete entry.details;
    truncated = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    truncated = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    truncated = true;
  }

  if (typeof entry.content === "string") {
    const res = truncateHistoryText(entry.content);
    entry.content = res.text;
    truncated ||= res.truncated;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) =>
      sanitizeHistoryContentBlock({ block, includeThinking: params.includeThinking }),
    );
    entry.content = updated.flatMap((item) =>
      item.block === null || item.block === undefined ? [] : [item.block],
    );
    truncated ||= updated.some((item) => item.truncated);
  }
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text);
    entry.text = res.text;
    truncated ||= res.truncated;
  }
  return { message: entry, truncated };
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function enforceSessionsHistoryHardCap(params: {
  items: unknown[];
  bytes: number;
  maxBytes: number;
  placeholderText: string;
}): { items: unknown[]; bytes: number; hardCapped: boolean } {
  if (params.bytes <= params.maxBytes) {
    return { items: params.items, bytes: params.bytes, hardCapped: false };
  }

  const last = params.items.at(-1);
  const lastOnly = last ? [last] : [];
  const lastBytes = jsonUtf8Bytes(lastOnly);
  if (lastBytes <= params.maxBytes) {
    return { items: lastOnly, bytes: lastBytes, hardCapped: true };
  }

  const placeholder = [
    {
      role: "assistant",
      content: params.placeholderText,
    },
  ];
  return { items: placeholder, bytes: jsonUtf8Bytes(placeholder), hardCapped: true };
}

export function sanitizeAndCapSessionMessages(params: {
  messages: unknown[];
  includeThinking: boolean;
  maxBytes?: number;
  placeholderText: string;
}): {
  messages: unknown[];
  bytes: number;
  truncated: boolean;
  droppedMessages: boolean;
  contentTruncated: boolean;
} {
  const maxBytes = params.maxBytes ?? SESSIONS_HISTORY_MAX_BYTES;
  const sanitizedMessages = params.messages.map((message) =>
    sanitizeHistoryMessage({ message, includeThinking: params.includeThinking }),
  );
  const contentTruncated = sanitizedMessages.some((entry) => entry.truncated);
  const cappedMessages = capArrayByJsonBytes(
    sanitizedMessages.map((entry) => entry.message),
    maxBytes,
  );
  const droppedMessages = cappedMessages.items.length < params.messages.length;
  const hardened = enforceSessionsHistoryHardCap({
    items: cappedMessages.items,
    bytes: cappedMessages.bytes,
    maxBytes,
    placeholderText: params.placeholderText,
  });
  const truncated = droppedMessages || contentTruncated || hardened.hardCapped;

  return {
    messages: hardened.items,
    bytes: hardened.bytes,
    truncated,
    droppedMessages: droppedMessages || hardened.hardCapped,
    contentTruncated,
  };
}

/**
 * Sanitize text content to strip tool call markers and thinking tags.
 * This ensures user-facing text doesn't leak internal tool representations.
 */
export function sanitizeTextContent(text: string): string {
  if (!text) {
    return text;
  }
  return stripThinkingTagsFromText(stripDowngradedToolCallText(stripMinimaxToolCallXml(text)));
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as { type?: unknown }).type !== "text") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      const sanitized = sanitizeTextContent(text);
      if (sanitized.trim()) {
        chunks.push(sanitized);
      }
    }
  }
  const joined = chunks.join("").trim();
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
  const errorContext =
    stopReason === "error" || (typeof errorMessage === "string" && Boolean(errorMessage.trim()));

  return joined ? sanitizeUserFacingText(joined, { errorContext }) : undefined;
}
