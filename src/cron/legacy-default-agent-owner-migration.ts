import path from "node:path";
import { normalizeAgentId } from "../routing/session-key.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { materializeLegacyDefaultCronJobOwnersInRecords } from "./legacy-default-agent-owner-records.js";
import { cronStoreKey } from "./store/key.js";
import {
  CronStoreEpochMismatchError,
  materializeCronRowAgentOwners,
  readCronStoreEpoch,
} from "./store/row-codec.js";

export type LegacyDefaultCronOwnerMigrationResult = {
  changes: string[];
  warnings: string[];
};

/** Startup-owned idempotent SQLite migration for rows that relied on the retired marker. */
export async function materializeLegacyDefaultCronJobOwners(params: {
  storePath: string;
  legacyDefaultAgentId: string;
  records?: Array<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  expectedStoreEpoch?: number;
  recordCommittedStoreEpoch?: (storeEpoch: number) => void;
  persistRecords?: (records: Array<Record<string, unknown>>) => Promise<number | void>;
}): Promise<LegacyDefaultCronOwnerMigrationResult> {
  const agentId = normalizeAgentId(params.legacyDefaultAgentId);
  try {
    // Runtime reads only canonical cron_jobs rows. Doctor passes its merged
    // legacy-JSON records here explicitly before any later archival repair.
    const usesExplicitRecords = Boolean(params.records && params.persistRecords);
    let rewritten: number;
    if (usesExplicitRecords) {
      rewritten = materializeLegacyDefaultCronJobOwnersInRecords(params.records ?? [], agentId);
    } else {
      const result = runOpenClawStateWriteTransaction(
        ({ db }) => {
          const storeKey = cronStoreKey(path.resolve(params.storePath));
          const currentEpoch = readCronStoreEpoch(db, storeKey);
          if (
            params.expectedStoreEpoch !== undefined &&
            params.expectedStoreEpoch !== currentEpoch
          ) {
            throw new CronStoreEpochMismatchError(params.expectedStoreEpoch, currentEpoch);
          }
          const rewrittenCount = materializeCronRowAgentOwners(db, storeKey, agentId);
          return { rewritten: rewrittenCount, storeEpoch: readCronStoreEpoch(db, storeKey) };
        },
        { env: params.env },
      );
      rewritten = result.rewritten;
      params.recordCommittedStoreEpoch?.(result.storeEpoch);
    }
    const persistedRewritten =
      params.records && params.persistRecords ? await params.persistRecords(params.records) : 0;
    const effectiveRewritten = Math.max(rewritten, persistedRewritten ?? 0);
    return effectiveRewritten > 0
      ? {
          changes: [
            `Assigned ${effectiveRewritten} legacy cron job${effectiveRewritten === 1 ? "" : "s"} to agent "${agentId}" before retiring the stored default.`,
          ],
          warnings: [],
        }
      : { changes: [], warnings: [] };
  } catch (error) {
    return {
      changes: [],
      warnings: [
        `Failed writing legacy cron owners at ${params.storePath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
