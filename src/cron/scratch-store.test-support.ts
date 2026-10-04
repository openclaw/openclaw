import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { CronJobScratchWriteInput } from "./scratch-contract.js";
import { writeCronJobScratchInDatabase } from "./scratch-write.kernel.js";
import { cronStoreKey } from "./store/key.js";

export function writeCronScratchFixture(
  params: Omit<CronJobScratchWriteInput, "storeKey" | "nowMs"> & {
    storePath: string;
    nowMs?: number;
    options?: OpenClawStateDatabaseOptions;
  },
) {
  const { storePath, options, nowMs = Date.now(), ...input } = params;
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      writeCronJobScratchInDatabase(db, {
        ...input,
        storeKey: cronStoreKey(storePath),
        nowMs,
      }).result,
    options,
  );
}
