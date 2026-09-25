import { readConfigMachineState } from "../state/config-machine-state.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import {
  markPromotionSlugsNotifiedInDatabase,
  PROMOTIONS_FEED_STATE_KEY,
  recordPromotionClaimInDatabase,
  type StoredPromotionsFeedState,
} from "./promotions-feed.kernel.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

type PromotionWorkerOperations = Pick<
  OpenClawStateWorkerOperations,
  "promotions.markNotified" | "promotions.recordClaim"
>;

export function executePromotionCommand(
  command: SqliteWorkerCommand<PromotionWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { path: string },
  openDatabase: () => OpenClawStateDatabase,
): PromotionWorkerOperations[keyof PromotionWorkerOperations]["output"] {
  if (command.type === "promotions.markNotified") {
    const stored = readConfigMachineState<StoredPromotionsFeedState>(
      PROMOTIONS_FEED_STATE_KEY,
      options,
    );
    const known = new Set(stored?.notifiedSlugs ?? []);
    const incoming = command.input.slugs.filter((slug) => !known.has(slug));
    if (incoming.length > 0) {
      runOpenClawStateWriteTransaction(
        ({ db }) => markPromotionSlugsNotifiedInDatabase(db, incoming, command.input.now),
        { ...options, database: openDatabase() },
        { operationLabel: "config-machine-state.update" },
      );
    }
    return true;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => recordPromotionClaimInDatabase(db, command.input),
    { ...options, database: openDatabase() },
  );
}
