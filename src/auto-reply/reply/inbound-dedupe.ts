import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { createDedupeCache, type DedupeCache } from "../../infra/dedupe.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;

const inboundDedupeCache = createDedupeCache({
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});

const normalizeProvider = (value?: string | null) => value?.trim().toLowerCase() || "";

function firstNonEmptyId(
  ...values: Array<string | number | bigint | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      return String(value);
    }
  }
  return null;
}

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

const resolveInboundBody = (ctx: MsgContext): string => {
  if (typeof ctx.BodyForCommands === "string") {
    return ctx.BodyForCommands;
  }
  if (typeof ctx.CommandBody === "string") {
    return ctx.CommandBody;
  }
  if (typeof ctx.RawBody === "string") {
    return ctx.RawBody;
  }
  if (typeof ctx.Body === "string") {
    return ctx.Body;
  }
  return "";
};

const resolveWebchatBodyFallbackId = (ctx: MsgContext, provider: string): string | null => {
  if (provider !== "webchat") {
    return null;
  }
  const body = resolveInboundBody(ctx);
  if (!body) {
    return null;
  }

  const stampMatch = body.match(/\[[^\]\n]*GMT[+-]\d+[^\]\n]*\]/i)?.[0]?.trim();
  if (!stampMatch) {
    return null;
  }

  const lines = body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.length > 0 ? lines[lines.length - 1] : "";
  return tail ? `bodyts:${stampMatch}:${tail.slice(0, 180)}` : `bodyts:${stampMatch}`;
};

export function resolveInboundMessageSid(ctx: MsgContext): string | null {
  // Keep precedence aligned with other inbound mappers (dispatch-acp, hook mapper)
  // to avoid subtle identity drift across code paths.
  return firstNonEmptyId(
    ctx.MessageSidFull,
    ctx.MessageSid,
    ctx.MessageSidFirst,
    ctx.MessageSidLast,
  );
}

export function buildInboundDedupeKey(ctx: MsgContext): string | null {
  const provider = normalizeProvider(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  const messageId = resolveInboundMessageSid(ctx) ?? resolveWebchatBodyFallbackId(ctx, provider);
  if (!provider || !messageId) {
    return null;
  }
  const peerId = resolveInboundPeerId(ctx);
  if (!peerId) {
    return null;
  }
  const sessionKey = ctx.SessionKey?.trim() ?? "";
  const accountId = ctx.AccountId?.trim() ?? "";
  const threadId =
    ctx.MessageThreadId !== undefined && ctx.MessageThreadId !== null
      ? String(ctx.MessageThreadId)
      : "";
  return [provider, accountId, sessionKey, peerId, threadId, messageId].filter(Boolean).join("|");
}

export function shouldSkipDuplicateInbound(
  ctx: MsgContext,
  opts?: { cache?: DedupeCache; now?: number },
): boolean {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return false;
  }
  const cache = opts?.cache ?? inboundDedupeCache;
  const skipped = cache.check(key, opts?.now);
  if (skipped && shouldLogVerbose()) {
    logVerbose(`inbound dedupe: skipped ${key}`);
  }
  return skipped;
}

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
}
