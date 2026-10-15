import { normalizeAgentId } from "../../routing/session-key.js";
import { assertAgentDatabaseAdmitted } from "../../state/agent-database-admission.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import type { SessionStoreWorkerReadScope } from "./session-entry-read-runtime.types.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";

/** Discover saved-input candidates without opening every session's history. */
export async function readPendingInputRecoveryEntriesInWorker(input: SessionStoreWorkerReadScope) {
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database }) => {
      const { entries } = await reader.readEntries({
        agentId: database.agentId,
        storePath: database.path,
        env: database.env,
        pendingInputRecovery: true,
      });
      return entries;
    },
    { lane: maintenanceLane, dataOnly: true },
  );
}

/** Keep the physical reader owner through a registry maintenance consumer and its commit guard. */
export function withSessionRegistryEntriesInWorker(
  input: SessionStoreWorkerReadScope,
  consume: (entries: SessionEntrySummary[], assertCurrent: () => void) => Promise<void>,
): Promise<void> {
  assertAgentDatabaseAdmitted(input.agentId, { env: input.env });
  return withSessionStoreReaderInWorker(
    input,
    async ({ reader, database, assertCurrent: assertReaderCurrent }) => {
      const assertCurrent = () => {
        assertAgentDatabaseAdmitted(input.agentId, { env: database.env });
        assertAgentDatabaseAdmitted(database.agentId, { env: database.env });
        assertReaderCurrent();
      };
      let afterSessionKey: string | undefined;
      do {
        assertCurrent();
        const { entries, nextCronRunSessionKey } = await reader.readEntries({
          agentId: database.agentId,
          storePath: database.path,
          env: database.env,
          cronRetention: { afterSessionKey, limit: 32 },
        });
        assertCurrent();
        await consume(entries, assertCurrent);
        afterSessionKey = nextCronRunSessionKey ?? undefined;
      } while (afterSessionKey !== undefined);
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
    async ({ reader, database }) => {
      const { entries, nextCronRunUpdatedAt } = await reader.readEntries({
        agentId: database.agentId,
        storePath: database.path,
        env: database.env,
        expiredCronRuns,
      });
      return { entries, nextCronRunUpdatedAt };
    },
    { lane: maintenanceLane, dataOnly: true },
  );
}
