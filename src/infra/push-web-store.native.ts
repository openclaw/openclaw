import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import * as store from "./push-web-store.kernel.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

// Opaque request guards can run SQLite. Their compatibility path keeps the full
// assertion beside the native write, never inside a worker transaction.
function withNativeWebPushDatabase<T>(
  context: OpenClawStateWorkerContext,
  operation: (database: OpenClawStateDatabase) => T,
): T {
  context.admission.assertCurrent();
  return runWithSqliteWorkerStateContext(context, () =>
    operation(
      openOpenClawStateDatabase({
        path: context.admission.databasePath,
        env: context.environment,
      }),
    ),
  );
}

export function setNativeWebPushSubscriptionPreferences(
  params: Omit<Parameters<typeof store.setWebPushSubscriptionPreferencesInDatabase>[0], "database">,
  context: OpenClawStateWorkerContext,
) {
  return withNativeWebPushDatabase(context, (database) =>
    store.setWebPushSubscriptionPreferencesInDatabase({ ...params, database }),
  );
}

export function upsertNativeWebPushSubscription(
  params: Omit<Parameters<typeof store.upsertWebPushSubscriptionInDatabase>[0], "database">,
  context: OpenClawStateWorkerContext,
) {
  return withNativeWebPushDatabase(context, (database) =>
    store.upsertWebPushSubscriptionInDatabase({ ...params, database }),
  );
}

export function deleteNativeBoundWebPushSubscription(
  params: Omit<Parameters<typeof store.deleteBoundWebPushSubscriptionInDatabase>[0], "database">,
  context: OpenClawStateWorkerContext,
) {
  return withNativeWebPushDatabase(context, (database) =>
    store.deleteBoundWebPushSubscriptionInDatabase({ ...params, database }),
  );
}
