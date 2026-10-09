import { normalizeAgentId } from "../../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import type { SessionStoreWorkerReadScope } from "./session-entry-read-runtime.types.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";

/** Keep the physical reader owner through a registry maintenance consumer and its commit guard. */
export function withSessionRegistryEntriesInWorker<T>(
  input: SessionStoreWorkerReadScope,
  consume: (entries: SessionEntrySummary[], assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  assertAgentDatabaseAdmitted(input.agentId, { env: input.env });
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database, assertCurrent: assertReaderCurrent }) => {
      const assertCurrent = () => {
        assertAgentDatabaseAdmitted(input.agentId, { env: database.env });
        assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
        assertReaderCurrent();
      };
      assertCurrent();
      const entries = await reader.readEntries({
        agentId: database.agentId,
        storePath: database.path,
        env: database.env,
        cronRetention: true,
      });
      assertCurrent();
      return await consume(entries, assertCurrent);
    },
    { lane: maintenanceLane },
  );
}

/** Return owned full entries only for expired cron runs; live deletion guards stay on the host. */
export async function readExpiredCronRunEntriesInWorker(
  input: SessionStoreWorkerReadScope & { updatedBefore: number },
) {
  const expiredCronRuns = {
    agentId: normalizeAgentId(input.agentId),
    updatedBefore: input.updatedBefore,
  };
  assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: input.env });
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database, assertCurrent }) => {
      const assertAdmitted = () => {
        assertAgentDatabaseAdmitted(expiredCronRuns.agentId, { env: database.env });
        assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
      };
      assertAdmitted();
      const entries = await reader.readEntries({
        agentId: database.agentId,
        storePath: database.path,
        env: database.env,
        expiredCronRuns,
      });
      assertAdmitted();
      assertCurrent();
      return entries;
    },
    { lane: maintenanceLane, dataOnly: true },
  );
}
