import { readConfigMachineState } from "../state/config-machine-state.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  markPromotionSlugsNotifiedInDatabase,
  PROMOTIONS_FEED_STATE_KEY,
  recordPromotionClaimInDatabase,
  type PreparedPromotionClaim,
  type StoredPromotionsFeedState,
} from "./promotions-feed.kernel.js";

export const promotionOperations = {
  "promotions.markNotified": (
    input: { slugs: string[]; now: number },
    { stateOptions, open },
  ): true => {
    const options = stateOptions();
    const stored = readConfigMachineState<StoredPromotionsFeedState>(
      PROMOTIONS_FEED_STATE_KEY,
      options,
    );
    const known = new Set(stored?.notifiedSlugs ?? []);
    const incoming = input.slugs.filter((slug) => !known.has(slug));
    if (incoming.length > 0) {
      runOpenClawStateWriteTransaction(
        ({ db }) => markPromotionSlugsNotifiedInDatabase(db, incoming, input.now),
        { ...options, database: open() },
        { operationLabel: "config-machine-state.update" },
      );
    }
    return true;
  },
  "promotions.recordClaim": (input: PreparedPromotionClaim, { stateOptions, open }) =>
    runOpenClawStateWriteTransaction(({ db }) => recordPromotionClaimInDatabase(db, input), {
      ...stateOptions(),
      database: open(),
    }),
} satisfies WorkerOperationHandlers;

export type PromotionWorkerOperations = WorkerOperations<typeof promotionOperations>;
