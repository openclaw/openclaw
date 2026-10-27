import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

export function resolveSqliteCanonicalRepairLookupKeys(
  canonicalKey: string,
  storedKeys: readonly string[],
): string[] {
  return uniqueStrings([
    canonicalKey,
    ...storedKeys,
    ...storedKeys.flatMap((key) => {
      const trimmedKey = key.trim();
      return [trimmedKey, normalizeStoreSessionKey(trimmedKey)];
    }),
  ]);
}

/** Receipt and presentation facts used by offline repair completion receipts. */
export function readSessionDeliveryRepairInventory(database: Pick<OpenClawAgentDatabase, "db">) {
  const db = getSessionKysely(database.db);
  const deliveries = executeSqliteQuerySync(
    database.db,
    db.selectFrom("conversation_deliveries").selectAll().orderBy("operation_id"),
  ).rows;
  const cache = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
  const progress = executeSqliteQuerySync(
    database.db,
    cache
      .selectFrom("cache_entries")
      .selectAll()
      .where("scope", "=", "conversation-progress")
      .orderBy("key"),
  ).rows;
  const conversationIds = uniqueStrings(deliveries.map((row) => row.conversation_id));
  const conversations =
    conversationIds.length === 0
      ? []
      : executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("conversations")
            .selectAll()
            .where("conversation_id", "in", conversationIds)
            .orderBy("conversation_id"),
        ).rows;
  return { deliveries, progress, conversations };
}

/** Caller owns the source snapshot and destination write transaction. */
export function copySessionDeliveriesForRepair(params: {
  canonicalKey: string;
  sourceKeys: readonly string[];
  linkedConversationIds?: readonly string[];
  source: Pick<OpenClawAgentDatabase, "db">;
  destination: OpenClawAgentDatabase;
  preserveDestination?: boolean;
}): void {
  const sourceKeys = params.sourceKeys;
  const sourceDb = getSessionKysely(params.source.db);
  const destinationDb = getSessionKysely(params.destination.db);
  const sourceKeyReferences = new Set(sourceKeys);
  const deliveryLookupKeys = resolveSqliteCanonicalRepairLookupKeys(
    params.canonicalKey,
    sourceKeys,
  );
  const competingDeliveryIdentities = new Set(
    executeSqliteQuerySync(
      params.source.db,
      sourceDb.selectFrom("session_nodes").select("session_key"),
    ).rows.flatMap((row) =>
      sourceKeyReferences.has(row.session_key) ? [] : [normalizeStoreSessionKey(row.session_key)],
    ),
  );
  const deliverySourceKeys = deliveryLookupKeys.filter(
    (key) =>
      sourceKeyReferences.has(key) ||
      !competingDeliveryIdentities.has(normalizeStoreSessionKey(key)),
  );
  const deliverySourceKeyReferences = new Set(deliverySourceKeys);
  const deliveries = executeSqliteQuerySync(
    params.source.db,
    sourceDb
      .selectFrom("conversation_deliveries")
      .selectAll()
      .where("source_session_key", "in", deliverySourceKeys),
  ).rows;
  const conversationIds = uniqueStrings([
    ...(params.linkedConversationIds ?? []),
    ...deliveries.map((delivery) => delivery.conversation_id),
  ]);
  if (conversationIds.length > 0) {
    const conversations = executeSqliteQuerySync(
      params.source.db,
      sourceDb
        .selectFrom("conversations")
        .selectAll()
        .where("conversation_id", "in", conversationIds),
    ).rows;
    for (const conversation of conversations) {
      if (params.preserveDestination) {
        const existing = executeSqliteQueryTakeFirstSync(
          params.destination.db,
          destinationDb
            .selectFrom("conversations")
            .selectAll()
            .where("conversation_id", "=", conversation.conversation_id),
        );
        if (existing) {
          const {
            created_at: _sourceCreated,
            updated_at: _sourceUpdated,
            ...sourceFacts
          } = conversation;
          const {
            created_at: _targetCreated,
            updated_at: _targetUpdated,
            ...targetFacts
          } = existing;
          if (!isDeepStrictEqual(sourceFacts, targetFacts)) {
            throw new Error(
              `delivery conversation ${conversation.conversation_id} differs between stores`,
            );
          }
          continue;
        }
      }
      const { conversation_id: _conversationId, ...replacement } = conversation;
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("conversations")
          .values(conversation)
          // conversation_id hashes the same fields as the natural unique identity.
          .onConflict((conflict) => conflict.column("conversation_id").doUpdateSet(replacement)),
      );
    }
    const sourceCache = getNodeSqliteKysely<AgentCacheDatabase>(params.source.db);
    const destinationCache = getNodeSqliteKysely<AgentCacheDatabase>(params.destination.db);
    for (const delivery of deliveries) {
      const canonicalDelivery = {
        ...delivery,
        source_session_key:
          delivery.source_session_key !== null &&
          deliverySourceKeyReferences.has(delivery.source_session_key)
            ? params.canonicalKey
            : delivery.source_session_key,
      };
      const existing = params.preserveDestination
        ? executeSqliteQueryTakeFirstSync(
            params.destination.db,
            destinationDb
              .selectFrom("conversation_deliveries")
              .selectAll()
              .where("operation_id", "=", delivery.operation_id),
          )
        : undefined;
      if (params.preserveDestination && existing) {
        if (!isDeepStrictEqual(existing, canonicalDelivery)) {
          throw new Error(`delivery receipt ${delivery.operation_id} differs between stores`);
        }
      }
      const { operation_id: _operationId, ...replacement } = canonicalDelivery;
      executeSqliteQuerySync(
        params.destination.db,
        destinationDb
          .insertInto("conversation_deliveries")
          .values(canonicalDelivery)
          .onConflict((conflict) => conflict.column("operation_id").doUpdateSet(replacement)),
      );
      const snapshot = executeSqliteQueryTakeFirstSync(
        params.source.db,
        sourceCache
          .selectFrom("cache_entries")
          .selectAll()
          .where("scope", "=", "conversation-progress")
          .where("key", "=", delivery.operation_id),
      );
      const retainedSnapshot =
        params.preserveDestination && existing
          ? executeSqliteQueryTakeFirstSync(
              params.destination.db,
              destinationCache
                .selectFrom("cache_entries")
                .selectAll()
                .where("scope", "=", "conversation-progress")
                .where("key", "=", delivery.operation_id),
            )
          : undefined;
      if (snapshot && retainedSnapshot && !isDeepStrictEqual(snapshot, retainedSnapshot)) {
        throw new Error(`delivery progress ${delivery.operation_id} differs between stores`);
      }
      if (snapshot) {
        executeSqliteQuerySync(
          params.destination.db,
          destinationCache
            .insertInto("cache_entries")
            .values(snapshot)
            .onConflict((conflict) => conflict.columns(["scope", "key"]).doUpdateSet(snapshot)),
        );
      } else if (!retainedSnapshot) {
        // Replacing a receipt cannot retain another receipt's presentation at the same key.
        executeSqliteQuerySync(
          params.destination.db,
          destinationCache
            .deleteFrom("cache_entries")
            .where("scope", "=", "conversation-progress")
            .where("key", "=", delivery.operation_id),
        );
      }
    }
  }
}
