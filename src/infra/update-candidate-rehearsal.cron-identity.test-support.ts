import { readCronDefaultStoreKeyInDatabase } from "../state/openclaw-state-db-cron-identity-migration.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "../state/openclaw-state-schema.test-support.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";

const environment = process.env;
const initializationCronDefaultStoreKey = captureOpenClawStateWorkerContext({
  env: environment,
}).initializationCronDefaultStoreKey;

try {
  const boundStoreKey = await withStateMigrationBackupForTest({ env: environment }, () => {
    const state = openOpenClawStateDatabase({ env: environment });
    return readCronDefaultStoreKeyInDatabase(state.db);
  });
  process.stdout.write(
    `CRON_IDENTITY_RESULT ${JSON.stringify({
      initializationCronDefaultStoreKey,
      boundStoreKey,
    })}\n`,
  );
} finally {
  closeOpenClawStateDatabaseForTest();
}
