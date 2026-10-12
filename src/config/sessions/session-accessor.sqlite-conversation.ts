import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import {
  encodeSqliteStringSet,
  executeSqliteQuerySync,
  sqliteStringSetEntries,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  conversationIdentityFromSessionEntry,
  type ConversationIdentity,
} from "./conversation-identity.js";
import {
  parseConversationRouteContext,
  refreshStoredConversationRouteContext,
  serializeStoredConversationRouteContext,
  type ConversationRouteContext,
} from "./conversation-route-context.js";
import {
  conversationPublication,
  type ConversationAssociationRow,
  type ConversationPublication,
} from "./session-accessor.sqlite-conversation-publication.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

type SessionConversationRole = "participant" | "primary" | "related";

type PreparedSessionConversation = {
  identity: ConversationIdentity;
  role: SessionConversationRole;
  routeContext?: ConversationRouteContext | null;
};

/** Keeps a previously observed route peer when a generic session writer has no route facts. */
function preserveSessionConversationIdentity(params: {
  database: OpenClawAgentDatabase;
  identity: ConversationIdentity;
  sessionIds: string[];
}): ConversationIdentity {
  if (params.sessionIds.length === 0) {
    return params.identity;
  }
  const db = getSessionKysely(params.database.db);
  const row = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_conversations as sc")
      .innerJoin("conversations as c", "c.conversation_id", "sc.conversation_id")
      .select([
        "c.conversation_id",
        "c.channel",
        "c.account_id",
        "c.kind",
        "c.peer_id",
        "c.delivery_target",
        "c.parent_conversation_id",
        "c.thread_id",
        "c.native_channel_id",
        "c.native_direct_user_id",
        "c.label",
        "c.metadata_json",
      ])
      .where("sc.session_id", "in", params.sessionIds)
      .where("c.channel", "=", params.identity.channel)
      .where("c.account_id", "=", params.identity.accountId)
      .where("c.kind", "=", params.identity.kind)
      .where("c.delivery_target", "=", params.identity.deliveryTarget)
      .where("sc.role", "in", ["primary", "participant"])
      .where("c.thread_id", params.identity.threadId ? "=" : "is", params.identity.threadId ?? null)
      .orderBy("sc.last_seen_at", "desc")
      .limit(1),
  ).rows[0];
  const metadata = row?.metadata_json ? safeParseJsonRecord(row.metadata_json) : undefined;
  return row
    ? {
        conversationRef: row.conversation_id,
        channel: row.channel,
        accountId: row.account_id,
        kind: params.identity.kind,
        peerId: row.peer_id,
        deliveryTarget: row.delivery_target,
        ...(row.parent_conversation_id
          ? { parentConversationRef: row.parent_conversation_id }
          : {}),
        ...(row.thread_id ? { threadId: row.thread_id } : {}),
        ...(row.native_channel_id ? { nativeChannelId: row.native_channel_id } : {}),
        ...(row.native_direct_user_id ? { nativeDirectUserId: row.native_direct_user_id } : {}),
        ...((params.identity.label ?? row.label)
          ? { label: params.identity.label ?? row.label! }
          : {}),
        ...(metadata ? { metadata } : {}),
      }
    : params.identity;
}

/** Shared-main DMs multiplex peers through one context; every other routed session has one primary. */
export function prepareSessionConversationForWrite(params: {
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  previousEntry?: SessionEntry | null;
  routeContext?: ConversationRouteContext | null;
  sessionScope: string;
}): PreparedSessionConversation | null {
  const routeContext =
    params.routeContext === null
      ? null
      : params.routeContext === undefined
        ? undefined
        : parseConversationRouteContext(params.routeContext);
  if (params.routeContext !== undefined && params.routeContext !== null && !routeContext) {
    throw new Error("Invalid conversation route context");
  }
  const identity = conversationIdentityFromSessionEntry(params.entry, routeContext);
  if (!identity) {
    return null;
  }
  return {
    identity:
      routeContext === undefined
        ? preserveSessionConversationIdentity({
            database: params.database,
            identity,
            sessionIds: [params.entry.sessionId, params.previousEntry?.sessionId].filter(
              (sessionId): sessionId is string => Boolean(sessionId),
            ),
          })
        : identity,
    role:
      params.sessionScope === "shared-main" && identity.kind === "direct"
        ? "participant"
        : "primary",
    ...(routeContext !== undefined ? { routeContext } : {}),
  };
}

export function prepareConversationIdentities(
  identities: readonly ConversationIdentity[],
): string | undefined {
  if (!identities.length) {
    return undefined;
  }
  // RETURNING order is unspecified; each address must have only its final postimage.
  const current = new Map(identities.map((identity) => [identity.conversationRef, identity]));
  return encodeSqliteStringSet(
    [...current.values()].flatMap((identity) => [
      identity.conversationRef,
      identity.channel,
      identity.accountId,
      identity.kind,
      identity.peerId,
      identity.deliveryTarget,
      identity.parentConversationRef ?? null,
      identity.threadId ?? null,
      identity.nativeChannelId ?? null,
      identity.nativeDirectUserId ?? null,
      identity.label ?? null,
      identity.metadata ? JSON.stringify(identity.metadata) : null,
    ]),
  );
}

/** Upserts addresses before session rows so their primary-conversation FKs remain valid. */
export function upsertConversationIdentities(
  database: OpenClawAgentDatabase,
  encoded: string | undefined,
  updatedAt: number,
): ConversationPublication | undefined {
  if (encoded === undefined) {
    return undefined;
  }
  const db = getSessionKysely(database.db);
  const columns = [
    "conversation_id",
    "channel",
    "account_id",
    "kind",
    "peer_id",
    "delivery_target",
    "parent_conversation_id",
    "thread_id",
    "native_channel_id",
    "native_direct_user_id",
    "label",
    "metadata_json",
  ] as const;
  const fields = sqliteStringSetEntries(encoded).as("field");
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("conversations")
      .columns([...columns, "created_at", "updated_at"])
      .expression((query) =>
        query
          .selectFrom(fields)
          .select((eb) => [
            ...columns.map((column, index) =>
              eb.fn
                .max<string>(
                  eb
                    .case()
                    .when(eb("field.key", "%", columns.length), "=", index)
                    .then(eb.ref("field.value"))
                    .end(),
                )
                .as(column),
            ),
            eb.val(updatedAt).as("created_at"),
            eb.val(updatedAt).as("updated_at"),
          ])
          .where("field.key", ">=", 0)
          .groupBy((eb) => eb.cast<number>(eb("field.key", "/", columns.length), "integer"))
          .orderBy((eb) => eb.cast<number>(eb("field.key", "/", columns.length), "integer")),
      )
      .onConflict((conflict) =>
        conflict.column("conversation_id").doUpdateSet((eb) => ({
          channel: eb.ref("excluded.channel"),
          account_id: eb.ref("excluded.account_id"),
          kind: eb.ref("excluded.kind"),
          peer_id: eb.ref("excluded.peer_id"),
          delivery_target: eb.ref("excluded.delivery_target"),
          parent_conversation_id: eb.ref("excluded.parent_conversation_id"),
          thread_id: eb.ref("excluded.thread_id"),
          native_channel_id: eb.ref("excluded.native_channel_id"),
          native_direct_user_id: eb.ref("excluded.native_direct_user_id"),
          label: eb.ref("excluded.label"),
          metadata_json: eb.ref("excluded.metadata_json"),
          updated_at: updatedAt,
        })),
      )
      .returningAll(),
  ).rows;
  return conversationPublication.stageRows(database, { catalogues: rows });
}

/** Links one external address to its local context without conflating the two identities. */
export function linkSessionConversation(params: {
  database: OpenClawAgentDatabase;
  previousSessionId?: string;
  sessionId: string;
  conversation: PreparedSessionConversation;
  updatedAt: number;
}): void {
  const { database, sessionId, conversation, updatedAt } = params;
  const db = getSessionKysely(database.db);
  const readAssociation = (candidateSessionId: string) =>
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_conversations")
        .select(["last_seen_at", "route_context_json"])
        .where("session_id", "=", candidateSessionId)
        .where("conversation_id", "=", conversation.identity.conversationRef)
        .orderBy("last_seen_at", "desc")
        .limit(1),
    ).rows[0];
  const existingAssociation =
    conversation.routeContext === undefined
      ? (readAssociation(sessionId) ??
        (params.previousSessionId && params.previousSessionId !== sessionId
          ? readAssociation(params.previousSessionId)
          : undefined))
      : undefined;
  const routeContextJson =
    conversation.routeContext === undefined
      ? existingAssociation
        ? refreshStoredConversationRouteContext(
            existingAssociation.route_context_json,
            existingAssociation.last_seen_at,
            updatedAt,
          )
        : null
      : serializeStoredConversationRouteContext(conversation.routeContext, updatedAt);
  const associations: ConversationAssociationRow[] = [];
  const removedAssociations: ConversationAssociationRow[] = [];
  if (conversation.role === "primary") {
    const stalePrimaryRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_conversations")
        .select(["conversation_id", "first_seen_at", "last_seen_at", "route_context_json"])
        .where("session_id", "=", sessionId)
        .where("role", "=", "primary")
        .where("conversation_id", "!=", conversation.identity.conversationRef),
    ).rows;
    if (stalePrimaryRows.length > 0) {
      const related = executeSqliteQuerySync(
        database.db,
        db
          .insertInto("session_conversations")
          .values(
            stalePrimaryRows.map((row) => ({
              session_id: sessionId,
              conversation_id: row.conversation_id,
              role: "related",
              route_context_json: refreshStoredConversationRouteContext(
                row.route_context_json,
                row.last_seen_at,
                updatedAt,
              ),
              first_seen_at: row.first_seen_at,
              last_seen_at: updatedAt,
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet((eb) => ({
              route_context_json: eb.ref("excluded.route_context_json"),
              last_seen_at: updatedAt,
            })),
          )
          .returningAll(),
      ).rows;
      associations.push(...related);
      const removed = executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("session_conversations")
          .where("session_id", "=", sessionId)
          .where("role", "=", "primary")
          .where("conversation_id", "!=", conversation.identity.conversationRef)
          .returningAll(),
      ).rows;
      removedAssociations.push(...removed);
    }
  }

  // A conversation has exactly one role within a session. Remove stale role rows
  // before inserting the current one because role participates in the table PK.
  const removed = executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("session_conversations")
      .where("session_id", "=", sessionId)
      .where("conversation_id", "=", conversation.identity.conversationRef)
      .where("role", "!=", conversation.role)
      .returningAll(),
  ).rows;
  removedAssociations.push(...removed);
  const linked = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_conversations")
      .values({
        session_id: sessionId,
        conversation_id: conversation.identity.conversationRef,
        role: conversation.role,
        route_context_json: routeContextJson,
        first_seen_at: updatedAt,
        last_seen_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["session_id", "conversation_id", "role"]).doUpdateSet({
          route_context_json: routeContextJson,
          last_seen_at: updatedAt,
        }),
      )
      .returningAll(),
  ).rows;
  associations.push(...linked);
  conversationPublication.stageRows(database, { associations, removedAssociations });
}
