import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { buildGroupDisplayName, resolveGroupSessionKey } from "./group.js";
import type { GroupKeyResolution, SessionEntry, SessionOrigin } from "./types.js";

type SessionRelationshipHintContext = MsgContext & {
  entityRefs?: unknown;
  incidentId?: unknown;
  threadEntityId?: unknown;
  repoRefs?: unknown;
  artifactRefs?: unknown;
  EntityRefs?: unknown;
  IncidentId?: unknown;
  ThreadEntityId?: unknown;
  RepoRefs?: unknown;
  ArtifactRefs?: unknown;
};

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRefList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const refs = value
    .map((entry) => trimNonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (refs.length === 0) {
    return undefined;
  }
  return [...new Set(refs)];
}

function mergeRefList(
  existing: string[] | undefined,
  next: string[] | undefined,
): string[] | undefined {
  if (!existing?.length && !next?.length) {
    return undefined;
  }
  return [...new Set([...(existing ?? []), ...(next ?? [])])];
}

const mergeOrigin = (
  existing: SessionOrigin | undefined,
  next: SessionOrigin | undefined,
): SessionOrigin | undefined => {
  if (!existing && !next) {
    return undefined;
  }
  const merged: SessionOrigin = existing ? { ...existing } : {};
  if (next?.label) {
    merged.label = next.label;
  }
  if (next?.provider) {
    merged.provider = next.provider;
  }
  if (next?.surface) {
    merged.surface = next.surface;
  }
  if (next?.chatType) {
    merged.chatType = next.chatType;
  }
  if (next?.from) {
    merged.from = next.from;
  }
  if (next?.to) {
    merged.to = next.to;
  }
  if (next?.accountId) {
    merged.accountId = next.accountId;
  }
  if (next?.threadId != null && next.threadId !== "") {
    merged.threadId = next.threadId;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

export function deriveSessionOrigin(ctx: MsgContext): SessionOrigin | undefined {
  const label = resolveConversationLabel(ctx)?.trim();
  const providerRaw =
    (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
    ctx.Surface ||
    ctx.Provider;
  const provider = normalizeMessageChannel(providerRaw);
  const surface = ctx.Surface?.trim().toLowerCase();
  const chatType = normalizeChatType(ctx.ChatType) ?? undefined;
  const from = ctx.From?.trim();
  const to =
    (typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To)?.trim() ?? undefined;
  const accountId = ctx.AccountId?.trim();
  const threadId = ctx.MessageThreadId ?? undefined;

  const origin: SessionOrigin = {};
  if (label) {
    origin.label = label;
  }
  if (provider) {
    origin.provider = provider;
  }
  if (surface) {
    origin.surface = surface;
  }
  if (chatType) {
    origin.chatType = chatType;
  }
  if (from) {
    origin.from = from;
  }
  if (to) {
    origin.to = to;
  }
  if (accountId) {
    origin.accountId = accountId;
  }
  if (threadId != null && threadId !== "") {
    origin.threadId = threadId;
  }

  return Object.keys(origin).length > 0 ? origin : undefined;
}

export function snapshotSessionOrigin(entry?: SessionEntry): SessionOrigin | undefined {
  if (!entry?.origin) {
    return undefined;
  }
  return { ...entry.origin };
}

function deriveSessionRelationshipPatch(ctx: MsgContext): Partial<SessionEntry> | null {
  const relationshipCtx = ctx as SessionRelationshipHintContext;
  const patch: Partial<SessionEntry> = {};

  const entityRefs = normalizeRefList(relationshipCtx.entityRefs ?? relationshipCtx.EntityRefs);
  if (entityRefs) {
    patch.entityRefs = entityRefs;
  }

  const incidentId = trimNonEmptyString(relationshipCtx.incidentId ?? relationshipCtx.IncidentId);
  if (incidentId) {
    patch.incidentId = incidentId;
  }

  const threadEntityId = trimNonEmptyString(
    relationshipCtx.threadEntityId ?? relationshipCtx.ThreadEntityId,
  );
  if (threadEntityId) {
    patch.threadEntityId = threadEntityId;
  }

  const repoRefs = normalizeRefList(relationshipCtx.repoRefs ?? relationshipCtx.RepoRefs);
  if (repoRefs) {
    patch.repoRefs = repoRefs;
  }

  const artifactRefs = normalizeRefList(
    relationshipCtx.artifactRefs ?? relationshipCtx.ArtifactRefs,
  );
  if (artifactRefs) {
    patch.artifactRefs = artifactRefs;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function deriveGroupSessionPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null {
  const resolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  if (!resolution?.channel) {
    return null;
  }

  const channel = resolution.channel;
  const subject = params.ctx.GroupSubject?.trim();
  const space = params.ctx.GroupSpace?.trim();
  const explicitChannel = params.ctx.GroupChannel?.trim();
  const normalizedChannel = normalizeChannelId(channel);
  const isChannelProvider = Boolean(
    normalizedChannel &&
    getChannelDock(normalizedChannel)?.capabilities.chatTypes.includes("channel"),
  );
  const nextGroupChannel =
    explicitChannel ??
    ((resolution.chatType === "channel" || isChannelProvider) && subject && subject.startsWith("#")
      ? subject
      : undefined);
  const nextSubject = nextGroupChannel ? undefined : subject;

  const patch: Partial<SessionEntry> = {
    chatType: resolution.chatType ?? "group",
    channel,
    groupId: resolution.id,
  };
  if (nextSubject) {
    patch.subject = nextSubject;
  }
  if (nextGroupChannel) {
    patch.groupChannel = nextGroupChannel;
  }
  if (space) {
    patch.space = space;
  }

  const displayName = buildGroupDisplayName({
    provider: channel,
    subject: nextSubject ?? params.existing?.subject,
    groupChannel: nextGroupChannel ?? params.existing?.groupChannel,
    space: space ?? params.existing?.space,
    id: resolution.id,
    key: params.sessionKey,
  });
  if (displayName) {
    patch.displayName = displayName;
  }

  return patch;
}

export function deriveSessionMetaPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null {
  const groupPatch = deriveGroupSessionPatch(params);
  const origin = deriveSessionOrigin(params.ctx);
  const relationships = deriveSessionRelationshipPatch(params.ctx);
  if (!groupPatch && !origin && !relationships) {
    return null;
  }

  const patch: Partial<SessionEntry> = groupPatch ? { ...groupPatch } : {};
  const mergedOrigin = mergeOrigin(params.existing?.origin, origin);
  if (mergedOrigin) {
    patch.origin = mergedOrigin;
  }
  if (relationships?.entityRefs) {
    patch.entityRefs = mergeRefList(params.existing?.entityRefs, relationships.entityRefs);
  }
  if (relationships?.incidentId) {
    patch.incidentId = relationships.incidentId;
  }
  if (relationships?.threadEntityId) {
    patch.threadEntityId = relationships.threadEntityId;
  }
  if (relationships?.repoRefs) {
    patch.repoRefs = mergeRefList(params.existing?.repoRefs, relationships.repoRefs);
  }
  if (relationships?.artifactRefs) {
    patch.artifactRefs = mergeRefList(params.existing?.artifactRefs, relationships.artifactRefs);
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
