import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  conversationIdentityFromSessionEntry,
  type ConversationIdentity,
} from "./conversation-identity.js";
import {
  normalizeStoredConversationRef,
  selectUniqueConversationRows,
  type MappedConversationRow,
} from "./conversation-record-policy.js";
import type { ConversationReadQuery, ConversationRecord } from "./conversation-registry.types.js";
import {
  parseConversationRouteContext,
  type ConversationRouteContext,
} from "./conversation-route-context.js";
import type {
  SessionActorMemoryConversationOwner,
  SessionActorMemoryConversationLink,
  SessionActorMemoryConversationAddress,
  SessionActorMemoryConversationRegistration,
  SessionActorMemoryConversationQuery,
  SessionActorMemoryConversationCommand,
} from "./session-actor-memory-conversation-contract.js";
import type {
  SessionActorMemoryState,
  SessionActorMemoryWindow,
} from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

function registerIdentities(
  shared: SessionActorMemoryConversationOwner,
  identities: readonly ConversationIdentity[],
  now: number,
): void {
  for (const identity of identities) {
    const previous = shared.catalog.get(identity.conversationRef);
    shared.catalog.set(identity.conversationRef, {
      identity: structuredClone(identity),
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
  }
}

/** The write records canonical addresses once; later authority reads only these stored rows. */
export function syncSessionActorMemoryConversations(
  state: SessionActorMemoryState,
  shared: SessionActorMemoryConversationOwner,
  previousEntry?: SessionEntry,
  observedContext?: ConversationRouteContext | null,
): void {
  const entry = state.hot.entry;
  if (!entry) {
    return;
  }
  const routeContext =
    observedContext === null
      ? null
      : observedContext === undefined
        ? undefined
        : parseConversationRouteContext(observedContext);
  if (observedContext !== undefined && observedContext !== null && !routeContext) {
    throw new Error("Invalid conversation route context");
  }
  let identity = conversationIdentityFromSessionEntry(entry, routeContext);
  state.primaryConversationRef = undefined;
  if (!identity) {
    return;
  }
  const previousWindow =
    previousEntry && previousEntry.sessionId !== entry.sessionId
      ? state.historicalWindows.get(previousEntry.sessionId)
      : undefined;
  const windows = [state, ...(previousWindow ? [previousWindow] : [])];
  if (routeContext === undefined) {
    const candidate = identity;
    const links: Array<[string, SessionActorMemoryConversationLink]> = [];
    for (const window of windows) {
      for (const link of window.conversationLinks) {
        links.push(link);
      }
    }
    const observed = links
      .filter(([, link]) => link.role === "primary" || link.role === "participant")
      .toSorted((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
      .map(([ref]) => shared.catalog.get(ref)?.identity)
      .find(
        (value) =>
          value &&
          value.channel === candidate.channel &&
          value.accountId === candidate.accountId &&
          value.kind === candidate.kind &&
          value.deliveryTarget === candidate.deliveryTarget &&
          value.threadId === candidate.threadId,
      );
    if (observed) {
      identity = { ...observed, label: identity.label ?? observed.label };
    }
  }
  const now = entry.updatedAt;
  registerIdentities(shared, [identity], now);
  // Incognito dashboard keys are individual contexts, never the shared-main DM root.
  const role = "primary";
  const previous = state.conversationLinks.get(identity.conversationRef);
  const inherited = previous ?? previousWindow?.conversationLinks.get(identity.conversationRef);
  const route =
    routeContext === undefined
      ? inherited && {
          routeContext: inherited.routeContext,
          routeContextObserved: inherited.routeContextObserved,
        }
      : { routeContext: routeContext ?? undefined, routeContextObserved: true as const };
  for (const [ref, link] of state.conversationLinks) {
    if (ref !== identity.conversationRef && link.role === "primary") {
      state.conversationLinks.set(ref, { ...link, role: "related", lastSeenAt: now });
    }
  }
  state.conversationLinks.set(identity.conversationRef, {
    role,
    firstSeenAt: previous?.role === role ? previous.firstSeenAt : now,
    lastSeenAt: now,
    ...route,
  });
  state.primaryConversationRef = identity.conversationRef;
}

function addressRecord(value: SessionActorMemoryConversationAddress): ConversationRecord {
  const {
    identity: { deliveryTarget, metadata: _metadata, ...identity },
    firstSeenAt,
    lastSeenAt,
  } = value;
  return { ...identity, target: deliveryTarget, firstSeenAt, lastSeenAt };
}

type ConversationReadContext = Pick<
  SessionActorMemoryStorageContext,
  "conversations" | "entries" | "get"
>;

/** Match the durable catalogue's current-binding preference without parsing transcript payloads. */
export function selectSessionActorMemoryConversations(
  context: ConversationReadContext,
  query: ConversationReadQuery,
): ConversationRecord[] {
  const channel = normalizeOptionalLowercaseString(query.channel);
  const ref =
    query.conversationRef === undefined
      ? undefined
      : normalizeStoredConversationRef(query.conversationRef);
  const refs =
    query.conversationRefs === undefined
      ? undefined
      : new Set(query.conversationRefs.map(normalizeStoredConversationRef));
  const records: Array<MappedConversationRow & { updatedAt: number }> = [];
  for (const [conversationRef, address] of context.conversations.catalog) {
    if (
      (channel && address.identity.channel !== channel) ||
      (ref && conversationRef !== ref) ||
      (refs && !refs.has(conversationRef))
    ) {
      continue;
    }
    let associated = false;
    for (const [sessionKey, state] of context.entries()) {
      const entry = state.hot.entry;
      const windows: SessionActorMemoryWindow[] = [state, ...state.historicalWindows.values()];
      for (const window of windows) {
        const link = window.conversationLinks.get(conversationRef);
        if (!link) {
          continue;
        }
        associated = true;
        const associationIsCurrent = Boolean(
          entry && window.hot.entry?.sessionId === entry.sessionId,
        );
        if (
          query.currentSession &&
          (sessionKey !== query.currentSession.sessionKey ||
            window.hot.entry?.sessionId !== query.currentSession.sessionId)
        ) {
          continue;
        }
        if (
          query.primarySession &&
          (!associationIsCurrent ||
            sessionKey !== query.primarySession.sessionKey ||
            entry?.sessionId !== query.primarySession.sessionId ||
            link.role !== "primary" ||
            window.primaryConversationRef !== conversationRef)
        ) {
          continue;
        }
        if (
          query.currentBindingOnly &&
          (!associationIsCurrent ||
            (link.role !== "participant" &&
              (link.role !== "primary" || window.primaryConversationRef !== conversationRef)))
        ) {
          continue;
        }
        records.push({
          associationIsCurrent,
          updatedAt: entry?.updatedAt ?? 0,
          record: {
            ...addressRecord(address),
            firstSeenAt: link.firstSeenAt,
            lastSeenAt: link.lastSeenAt,
            ...(entry ? { sessionId: entry.sessionId, sessionKey, role: link.role } : {}),
            observedFromSession: true,
            ...(link.routeContextObserved ? { routeContextObserved: true as const } : {}),
            ...(link.routeContext ? { routeContext: link.routeContext } : {}),
          },
        });
      }
    }
    if (
      !associated &&
      !query.primarySession &&
      !query.currentSession &&
      !query.currentBindingOnly
    ) {
      records.push({ associationIsCurrent: false, updatedAt: 0, record: addressRecord(address) });
    }
  }
  records.sort((a, b) => b.record.lastSeenAt - a.record.lastSeenAt || b.updatedAt - a.updatedAt);
  const selected = selectUniqueConversationRows(records, {
    conversationRef: (row) => row.record.conversationRef,
    map: (row) => row,
    limit: query.limit,
  });
  for (const record of selected) {
    if (record.sessionKey) {
      context.get(record.sessionKey);
    }
  }
  return selected;
}

export function readSessionActorMemoryConversation(
  context: ConversationReadContext,
  query: Exclude<
    SessionActorMemoryConversationQuery,
    { type: "session.conversation.delivery.read" }
  >,
) {
  if (query.type === "session.conversation.read") {
    return selectSessionActorMemoryConversations(context, query.input);
  }
  const operation =
    "operationId" in query.input
      ? context.conversations.deliveries.get(query.input.operationId.trim())
      : undefined;
  const ref =
    "conversationRef" in query.input ? query.input.conversationRef : operation?.conversationRef;
  return {
    operation: operation && { conversationRef: operation.conversationRef },
    conversation: ref
      ? selectSessionActorMemoryConversations(context, { conversationRef: ref, limit: 1 })[0]
      : undefined,
  };
}

export function writeSessionActorMemoryConversation(
  context: ConversationReadContext &
    Pick<SessionActorMemoryStorageContext, "admit" | "editConversations">,
  command: Extract<
    SessionActorMemoryConversationCommand,
    { type: "session.conversation.register" }
  >,
) {
  const selected: SessionActorMemoryConversationRegistration = {
    kind: "session.conversation.registration",
    identities: command.input.identities,
    eligible: command.input.identities.map(() => true),
  };
  context.admit("commit", selected);
  if (selected.eligible.length !== selected.identities.length) {
    throw new Error("Conversation route owner returned an incomplete eligibility selection");
  }
  const identities = selected.identities.filter((_, index) => selected.eligible[index]);
  if (!identities.length) {
    return undefined;
  }
  const shared = context.editConversations();
  registerIdentities(shared, identities, command.input.discoveredAt);
  return command.input.query
    ? selectSessionActorMemoryConversations(context, command.input.query)
    : undefined;
}
