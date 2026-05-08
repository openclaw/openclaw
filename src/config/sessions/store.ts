import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  applySqliteSessionEntriesPatch,
  deleteSqliteSessionEntry,
  listSqliteSessionEntries,
  readSqliteSessionEntry,
  replaceSqliteSessionEntry,
} from "./store-backend.sqlite.js";
import { normalizeSessionRowKey } from "./store-entry.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export { normalizeSessionRowKey, resolveSessionRowEntry } from "./store-entry.js";

const SESSION_ROW_PATCH_RETRY_LIMIT = 16;

type SessionEntryRowOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
};

export function getSessionEntry(
  options: SessionEntryRowOptions & { sessionKey: string },
): SessionEntry | undefined {
  const direct = readSqliteSessionEntry(options);
  if (direct) {
    return direct;
  }
  const normalizedKey = normalizeSessionRowKey(options.sessionKey);
  const normalized =
    normalizedKey === options.sessionKey
      ? undefined
      : readSqliteSessionEntry({
          ...options,
          sessionKey: normalizedKey,
        });
  return normalized;
}

export function listSessionEntries(
  options: SessionEntryRowOptions,
): Array<{ sessionKey: string; entry: SessionEntry }> {
  return listSqliteSessionEntries(options);
}

export function upsertSessionEntry(
  options: SessionEntryRowOptions & {
    sessionKey: string;
    entry: SessionEntry;
  },
): void {
  replaceSqliteSessionEntry(options);
}

export function deleteSessionEntry(
  options: SessionEntryRowOptions & { sessionKey: string },
): boolean {
  return deleteSqliteSessionEntry(options);
}

export async function patchSessionEntry(
  options: SessionEntryRowOptions & {
    sessionKey: string;
    fallbackEntry?: SessionEntry;
    update: (
      entry: SessionEntry,
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  },
): Promise<SessionEntry | null> {
  for (let attempt = 0; attempt < SESSION_ROW_PATCH_RETRY_LIMIT; attempt += 1) {
    const stored = getSessionEntry(options);
    const expected = stored ? structuredClone(stored) : null;
    const existing = stored
      ? structuredClone(stored)
      : options.fallbackEntry
        ? structuredClone(options.fallbackEntry)
        : undefined;
    if (!existing) {
      return null;
    }
    const patch = await options.update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    const applied = applySqliteSessionEntriesPatch({
      agentId: options.agentId,
      env: options.env,
      upsertEntries: { [options.sessionKey]: next },
      expectedEntries: new Map([[options.sessionKey, expected]]),
    });
    if (applied) {
      return next;
    }
  }
  throw new Error(
    `Session row update conflicted after ${SESSION_ROW_PATCH_RETRY_LIMIT} SQLite retries: ${options.sessionKey}`,
  );
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export function readSessionUpdatedAt(params: {
  agentId?: string;
  sessionKey: string;
}): number | undefined {
  try {
    const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
    if (!agentId) {
      return undefined;
    }
    const normalizedKey = normalizeSessionRowKey(params.sessionKey);
    const entry =
      readSqliteSessionEntry({
        agentId,
        sessionKey: normalizedKey,
      }) ??
      (normalizedKey === params.sessionKey
        ? undefined
        : readSqliteSessionEntry({
            agentId,
            sessionKey: params.sessionKey,
          }));
    return entry?.updatedAt;
  } catch {
    return undefined;
  }
}

function resolveSessionRowOptionsFromSessionKey(params: {
  agentId?: string;
  sessionKey: string;
}): SessionEntryRowOptions {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  if (!agentId) {
    throw new Error(
      `Session stores are SQLite-only; cannot resolve agent for ${params.sessionKey}`,
    );
  }
  return { agentId };
}

export async function recordSessionMetaFromInbound(params: {
  agentId?: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  const rowOptions = resolveSessionRowOptionsFromSessionKey({
    agentId: params.agentId,
    sessionKey,
  });
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  const existing = getSessionEntry({ ...rowOptions, sessionKey });
  const patch = deriveSessionMetaPatch({
    ctx,
    sessionKey: normalizedKey,
    existing,
    groupResolution: params.groupResolution,
  });
  if (!patch) {
    if (existing && normalizedKey !== sessionKey.trim()) {
      upsertSessionEntry({ ...rowOptions, sessionKey: normalizedKey, entry: existing });
    }
    return existing ?? null;
  }
  if (!existing && !createIfMissing) {
    return null;
  }
  const next = existing
    ? // Inbound metadata updates must not refresh activity timestamps;
      // idle reset evaluation relies on updatedAt from actual session turns.
      mergeSessionEntryPreserveActivity(existing, patch)
    : mergeSessionEntry(existing, patch);
  upsertSessionEntry({
    ...rowOptions,
    sessionKey: normalizedKey,
    entry: next,
  });
  return next;
}

export async function updateLastRoute(params: {
  agentId?: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { sessionKey, channel, to, accountId, threadId, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  const rowOptions = resolveSessionRowOptionsFromSessionKey({
    agentId: params.agentId,
    sessionKey,
  });
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  const existing = getSessionEntry({ ...rowOptions, sessionKey });
  if (!existing && !createIfMissing) {
    return null;
  }
  const explicitContext = normalizeDeliveryContext(params.deliveryContext);
  const inlineContext = normalizeDeliveryContext({
    channel,
    to,
    accountId,
    threadId,
  });
  const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
  const explicitDeliveryContext = params.deliveryContext;
  const explicitThreadFromDeliveryContext =
    explicitDeliveryContext != null &&
    Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
      ? explicitDeliveryContext.threadId
      : undefined;
  const explicitThreadValue =
    explicitThreadFromDeliveryContext ??
    (threadId != null && threadId !== "" ? threadId : undefined);
  const explicitRouteProvided = Boolean(
    explicitContext?.channel || explicitContext?.to || inlineContext?.channel || inlineContext?.to,
  );
  const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
  const fallbackContext = clearThreadFromFallback
    ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
    : deliveryContextFromSession(existing);
  const merged = mergeDeliveryContext(mergedInput, fallbackContext);
  const normalized = normalizeSessionDeliveryFields({
    deliveryContext: {
      channel: merged?.channel,
      to: merged?.to,
      accountId: merged?.accountId,
      threadId: merged?.threadId,
    },
  });
  const metaPatch = ctx
    ? deriveSessionMetaPatch({
        ctx,
        sessionKey: normalizedKey,
        existing,
        groupResolution: params.groupResolution,
      })
    : null;
  const basePatch: Partial<SessionEntry> = {
    deliveryContext: normalized.deliveryContext,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
  // Route updates must not refresh activity timestamps; idle/daily reset
  // evaluation relies on updatedAt from actual session turns (#49515).
  const next = mergeSessionEntryPreserveActivity(
    existing,
    metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
  );
  upsertSessionEntry({
    ...rowOptions,
    sessionKey: normalizedKey,
    entry: next,
  });
  return next;
}
