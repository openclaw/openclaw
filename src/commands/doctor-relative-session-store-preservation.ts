import { readSessionTranscriptArchiveResetInventory } from "../config/sessions/session-accessor.sqlite-archive-store-kernel.js";
import {
  readSessionDeliveryRepairInventory,
  resolveSqliteCanonicalRepairLookupKeys,
} from "../config/sessions/session-accessor.sqlite-delivery-repair.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";

type PendingState = Pick<DB, "context_engine_turn_outbox" | "session_goal_operations">;

/** A retired store must have no independent owner still settling work against it. */
export function readRelativeStorePreservationState(
  database: Pick<OpenClawAgentDatabase, "db">,
  keys: readonly string[],
  refuse: (message: string) => never,
) {
  const pending = getNodeSqliteKysely<PendingState>(database.db);
  if (
    executeSqliteQueryTakeFirstSync(
      database.db,
      pending.selectFrom("context_engine_turn_outbox").select("advancement_key").limit(1),
    )
  ) {
    refuse(
      "pending context-engine advancements need to drain through their original Gateway before recovery",
    );
  }
  const goalOperation = executeSqliteQueryTakeFirstSync(
    database.db,
    pending
      .selectFrom("session_goal_operations")
      .select("expires_at")
      .where("expires_at", ">", Date.now())
      .orderBy("expires_at", "desc")
      .limit(1),
  );
  if (goalOperation) {
    refuse(
      `goal-operation receipts prevent delayed goal recreation until ${new Date(goalOperation.expires_at).toISOString()}; retain the old store until that time before retrying`,
    );
  }
  if (readSessionTranscriptArchiveResetInventory(database).length > 0) {
    refuse(
      "retained transcript archives require explicit recovery from the original store; automatic archive relocation is unsupported",
    );
  }
  const inventory = readSessionDeliveryRepairInventory(database);
  if (inventory.deliveries.some((row) => ["created", "queued", "unknown"].includes(row.status))) {
    refuse(
      "pending conversation deliveries must settle through their original Gateway and queue before recovery",
    );
  }
  const knownKeys = new Set(
    keys.flatMap((key) => resolveSqliteCanonicalRepairLookupKeys(key, [key])),
  );
  if (
    inventory.deliveries.some(
      (row) => row.source_session_key === null || !knownKeys.has(row.source_session_key),
    )
  ) {
    refuse(
      "delivery receipts without a retained session require explicit recovery from the original store",
    );
  }
  const operations = new Set(inventory.deliveries.map((row) => row.operation_id));
  if (inventory.progress.some((row) => !operations.has(row.key))) {
    refuse(
      "conversation progress without its delivery receipt requires explicit recovery from the original store",
    );
  }
  return inventory;
}
