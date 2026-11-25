import { randomUUID } from "node:crypto";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../../auto-reply/templating.js";

const MAX_ROUTE_CONTEXT_ID_LENGTH = 512;
// Discord currently caps server roles below this; keep persisted authorization input bounded.
const MAX_ROUTE_CONTEXT_ROLE_IDS = 256;
const MAX_STORED_ROUTE_CONTEXT_LENGTH = 140_000;

export type ConversationRouteContext = {
  peerId?: string;
  guildId?: string;
  teamId?: string;
  parentPeerId?: string;
  memberRoleIds?: string[];
};

type ConversationRouteContextObservation = {
  context?: ConversationRouteContext;
};

function normalizeBoundedId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length <= MAX_ROUTE_CONTEXT_ID_LENGTH ? normalized : undefined;
}

function normalizeRoleIds(value: unknown): { valid: boolean; value?: string[] } {
  if (value === undefined) {
    return { valid: true };
  }
  if (!Array.isArray(value) || value.length > MAX_ROUTE_CONTEXT_ROLE_IDS) {
    return { valid: false };
  }
  const roleIds: string[] = [];
  for (const item of value) {
    const roleId = normalizeBoundedId(item);
    if (!roleId) {
      return { valid: false };
    }
    roleIds.push(roleId);
  }
  const unique = [...new Set(roleIds)].toSorted();
  return unique.length > 0 ? { valid: true, value: unique } : { valid: true };
}

/** Parses the closed, bounded route facts used to replay configured routing precedence. */
export function parseConversationRouteContext(
  value: unknown,
): ConversationRouteContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const context: ConversationRouteContext = {};
  for (const key of ["peerId", "guildId", "teamId", "parentPeerId"] as const) {
    const id = normalizeBoundedId(value[key]);
    if (value[key] !== undefined && !id) {
      return undefined;
    }
    if (id) {
      context[key] = id;
    }
  }
  const memberRoleIds = normalizeRoleIds(value.memberRoleIds);
  if (!memberRoleIds.valid) {
    return undefined;
  }
  if (memberRoleIds.value) {
    context.memberRoleIds = memberRoleIds.value;
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

/** Captures only authoritative inbound facts needed to replay configured route precedence. */
export function conversationRouteContextFromMsgContext(
  ctx: MsgContext,
): ConversationRouteContext | undefined {
  const channel = normalizeOptionalLowercaseString(ctx.OriginatingChannel ?? ctx.Provider);
  const spaceId = normalizeBoundedId(ctx.GroupSpace);
  const parentPeerId = normalizeBoundedId(ctx.ThreadParentId);
  return parseConversationRouteContext({
    ...(ctx.ConversationRoutePeerId !== undefined ? { peerId: ctx.ConversationRoutePeerId } : {}),
    ...(channel === "discord" && spaceId ? { guildId: spaceId } : {}),
    ...((channel === "slack" || channel === "mattermost" || channel === "msteams") && spaceId
      ? { teamId: spaceId }
      : {}),
    ...(parentPeerId ? { parentPeerId } : {}),
    ...(ctx.MemberRoleIds !== undefined ? { memberRoleIds: ctx.MemberRoleIds } : {}),
  });
}

type StoredConversationRouteContext = {
  version: 1;
  // Current writers rotate this on every association update. Older writers preserve it,
  // allowing the SQLite trigger to invalidate route facts even when activity time is unchanged.
  writeId: string;
  observedAt: number;
  context: ConversationRouteContext | null;
};

export function serializeStoredConversationRouteContext(
  context: ConversationRouteContext | null,
  observedAt: number,
): string {
  const canonical = context === null ? null : parseConversationRouteContext(context);
  if (context !== null && !canonical) {
    throw new Error("Invalid conversation route context");
  }
  return JSON.stringify({
    version: 1,
    writeId: randomUUID(),
    observedAt,
    context: canonical ?? null,
  } satisfies StoredConversationRouteContext);
}

export function parseStoredConversationRouteContext(
  value: string | null,
  expectedObservedAt: number | null,
): ConversationRouteContextObservation | undefined {
  if (!value || value.length > MAX_STORED_ROUTE_CONTEXT_LENGTH) {
    return undefined;
  }
  const parsed = safeParseJson(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.writeId !== "string" ||
    parsed.writeId.length === 0 ||
    typeof parsed.observedAt !== "number" ||
    parsed.observedAt !== expectedObservedAt
  ) {
    return undefined;
  }
  const context = parseConversationRouteContext(parsed.context);
  if (parsed.context !== null && !context) {
    return undefined;
  }
  return context ? { context } : {};
}

export function refreshStoredConversationRouteContext(
  value: string | null,
  previousObservedAt: number,
  observedAt: number,
): string | null {
  const stored = parseStoredConversationRouteContext(value, previousObservedAt);
  return stored
    ? serializeStoredConversationRouteContext(stored.context ?? null, observedAt)
    : null;
}
