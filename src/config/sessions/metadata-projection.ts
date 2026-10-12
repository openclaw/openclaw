import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../../utils/delivery-context.read.js";
import {
  deliveryContextFromChannelRoute,
  deliveryContextKey,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryState,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../../utils/message-channel-constants.js";
import { buildGroupDisplayName } from "./group-display.js";
import type { GroupKeyResolution, SessionEntry, SessionOrigin } from "./types.js";

type SessionMetaSource = Pick<
  SessionEntry,
  "delivery" | "subject" | "topicName" | "groupChannel" | "space"
>;

export type PreparedSessionMetaPatch = {
  group: {
    resolution: GroupKeyResolution;
    nextSubject: string | undefined;
    nextGroupChannel: string | undefined;
    topicName: string | undefined;
    space: string | undefined;
  } | null;
  origin: SessionOrigin | undefined;
  internalTurn: boolean;
};

function hasExternalOriginChange(
  existing: SessionOrigin | undefined,
  next: SessionOrigin | undefined,
): boolean {
  const nextProvider = next?.provider;
  return (
    nextProvider != null &&
    nextProvider !== INTERNAL_MESSAGE_CHANNEL &&
    !isInternalNonDeliveryChannel(nextProvider) &&
    (!existing ||
      (existing.provider != null && nextProvider !== existing.provider) ||
      (existing.surface != null && next?.surface != null && next.surface !== existing.surface) ||
      (existing.accountId != null &&
        next?.accountId != null &&
        next.accountId !== existing.accountId))
  );
}

export const mergeSessionOrigin = (
  existing: SessionOrigin | undefined,
  next: SessionOrigin | undefined,
): SessionOrigin | undefined => {
  if (!existing && !next) {
    return undefined;
  }
  const merged: SessionOrigin = existing ? { ...existing } : {};
  // A provider/surface/account change is a fresh channel identity (e.g. a dmScope:"main" session
  // moving Slack -> Telegram, or between Slack accounts). Channel-keyed fields belong to the prior
  // channel; drop them so an inbound that omits them does not keep reactions, native threading, and
  // status reads pointed at the previous channel.
  if (existing != null && hasExternalOriginChange(existing, next)) {
    delete merged.nativeChannelId;
    delete merged.nativeDirectUserId;
    delete merged.avatar;
    delete merged.accountId;
    delete merged.threadId;
  }
  const mergeField = <K extends keyof SessionOrigin>(field: K, value: SessionOrigin[K]) => {
    if (value) {
      merged[field] = value;
    }
  };
  for (const field of [
    "label",
    "provider",
    "surface",
    "chatType",
    "from",
    "to",
    "nativeChannelId",
    "nativeDirectUserId",
    "avatar",
    "accountId",
  ] as const) {
    mergeField(field, next?.[field]);
  }
  if (next?.threadId != null && next.threadId !== "") {
    merged.threadId = next.threadId;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

function projectGroupSessionPatch(
  group: PreparedSessionMetaPatch["group"],
  existing: SessionMetaSource | undefined,
  sessionKey: string,
): Partial<SessionEntry> | null {
  if (!group) {
    return null;
  }
  const { resolution, nextSubject, nextGroupChannel, topicName, space } = group;
  const patch: Partial<SessionEntry> = {
    chatType: resolution.chatType ?? "group",
    groupId: resolution.id,
  };
  if (nextSubject) {
    patch.subject = nextSubject;
    // These fields are alternate presentations of the same chat. Clear the stale channel title
    // when ingress now owns a human subject, or an old opaque route id will keep winning in UI.
    patch.groupChannel = undefined;
  }
  if (nextGroupChannel) {
    patch.groupChannel = nextGroupChannel;
    patch.subject = undefined;
  }
  if (space) {
    patch.space = space;
  }
  if (topicName) {
    patch.topicName = topicName;
  }

  const displayName = buildGroupDisplayName({
    provider: resolution.channel,
    subject: nextSubject ?? (nextGroupChannel ? undefined : existing?.subject),
    topicName: topicName ?? existing?.topicName,
    groupChannel: nextGroupChannel ?? (nextSubject ? undefined : existing?.groupChannel),
    space: space ?? existing?.space,
    id: resolution.id,
    key: sessionKey,
  });
  if (displayName) {
    patch.displayName = displayName;
  }

  return patch;
}

export function projectSessionMetaPatch(params: {
  prepared: PreparedSessionMetaPatch;
  sessionKey: string;
  existing?: SessionMetaSource;
  preserveExistingDeliveryRoute?: boolean;
}): Partial<SessionEntry> | null {
  const { origin, internalTurn } = params.prepared;
  const groupPatch = projectGroupSessionPatch(
    params.prepared.group,
    params.existing,
    params.sessionKey,
  );
  if (!groupPatch && !origin) {
    return null;
  }
  const existingOrigin = sessionDeliveryOrigin(params.existing);
  const nextProvider = origin?.provider;
  const nextOwnsExternalRoute = Boolean(
    nextProvider &&
    nextProvider !== INTERNAL_MESSAGE_CHANNEL &&
    !isInternalNonDeliveryChannel(nextProvider),
  );
  if (existingOrigin && internalTurn) {
    const existingContext = normalizeDeliveryContext({
      channel: existingOrigin.provider,
      to: existingOrigin.to,
      accountId: existingOrigin.accountId,
      threadId: existingOrigin.threadId,
    });
    const nextContext = mergeDeliveryContext(
      {
        channel: nextProvider,
        to: origin?.to,
        accountId: origin?.accountId,
        threadId: origin?.threadId,
      },
      existingContext,
    );
    // Internal callers describe their own direct turn, not the bound channel conversation.
    // Preserve that identity unless the caller supplies a different external delivery route.
    if (
      !nextOwnsExternalRoute ||
      (existingContext && deliveryContextKey(nextContext) === deliveryContextKey(existingContext))
    ) {
      return null;
    }
  }

  const patch: Partial<SessionEntry> = groupPatch ? { ...groupPatch } : {};
  const mergedOrigin = mergeSessionOrigin(existingOrigin, origin);
  if (mergedOrigin) {
    if (!patch.chatType && mergedOrigin.chatType) {
      patch.chatType = mergedOrigin.chatType;
    }
    const existingRoute = sessionDeliveryRoute(params.existing);
    const existingRouteAccountId =
      existingRoute?.accountId ?? deliveryContextFromSession(params.existing)?.accountId;
    const freshRouteOwnsNextProvider =
      params.preserveExistingDeliveryRoute === true &&
      nextProvider != null &&
      existingRoute?.channel === nextProvider &&
      (origin?.accountId == null || existingRouteAccountId === origin.accountId);
    const deliveryIdentityChanged =
      Boolean(nextProvider) &&
      !freshRouteOwnsNextProvider &&
      hasExternalOriginChange(existingOrigin, origin);
    patch.delivery = normalizeSessionDeliveryState({
      route: deliveryIdentityChanged ? undefined : sessionDeliveryRoute(params.existing),
      context: deliveryIdentityChanged
        ? {
            channel: mergedOrigin.provider,
            to: mergedOrigin.to,
            accountId: mergedOrigin.accountId,
            threadId: mergedOrigin.threadId,
          }
        : deliveryContextFromSession(params.existing),
      origin: mergedOrigin,
    });
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function withoutThread<T extends { threadId?: string | number }>(identity?: T): T | undefined {
  if (!identity || identity.threadId == null) {
    return identity;
  }
  const next: T = { ...identity };
  delete next.threadId;
  return next;
}

export function projectLastRoutePatch(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  existing: SessionEntry | undefined;
  sessionKey: string;
  metadata?: PreparedSessionMetaPatch;
}): Partial<SessionEntry> {
  const { channel, to, accountId, threadId, existing } = params;
  const explicitContext = normalizeDeliveryContext(params.deliveryContext);
  const inlineContext = normalizeDeliveryContext({
    channel,
    to,
    accountId,
    threadId,
  });
  const routeContext = deliveryContextFromChannelRoute(params.route);
  const mergedInput = mergeDeliveryContext(
    routeContext,
    mergeDeliveryContext(explicitContext, inlineContext),
  );
  const explicitDeliveryContext = params.deliveryContext;
  const explicitThreadFromDeliveryContext =
    explicitDeliveryContext != null && Object.hasOwn(explicitDeliveryContext, "threadId")
      ? explicitDeliveryContext.threadId
      : undefined;
  const explicitThreadValue =
    explicitThreadFromDeliveryContext ??
    (threadId != null && threadId !== "" ? threadId : undefined);
  const explicitRouteProvided = Boolean(
    routeContext?.channel ||
    routeContext?.to ||
    explicitContext?.channel ||
    explicitContext?.to ||
    inlineContext?.channel ||
    inlineContext?.to,
  );
  const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
  const fallbackContext = clearThreadFromFallback
    ? withoutThread(deliveryContextFromSession(existing))
    : deliveryContextFromSession(existing);
  const existingOrigin = sessionDeliveryOrigin(existing);
  // Explicit thread absence owns both fallbacks, so origin cannot restore a stale thread.
  const fallbackOrigin = clearThreadFromFallback ? withoutThread(existingOrigin) : existingOrigin;
  const delivery = normalizeSessionDeliveryState({
    route: params.route,
    context: mergeDeliveryContext(mergedInput, fallbackContext),
    origin: fallbackOrigin,
  });
  const nextEntry = { ...existing, delivery };
  const metaPatch = params.metadata
    ? projectSessionMetaPatch({
        prepared: params.metadata,
        sessionKey: params.sessionKey,
        existing: nextEntry,
        preserveExistingDeliveryRoute: routeContext != null,
      })
    : null;
  const basePatch: Partial<SessionEntry> = { delivery };
  return metaPatch ? { ...basePatch, ...metaPatch } : basePatch;
}
