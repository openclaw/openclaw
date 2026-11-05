import { ensureColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { EngineConnection } from "./sql-connection.js";

/** Shared by the worker store and offline legacy migration. */
export function ensureWebPushSubscriptionBindingColumns(db: EngineConnection): void {
  ensureColumn(db, "web_push_subscriptions", "device_id TEXT");
  ensureColumn(db, "web_push_subscriptions", "user_profile_id TEXT");
  ensureColumn(db, "web_push_subscriptions", "preferences_json TEXT");
}
