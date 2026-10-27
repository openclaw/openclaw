import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { upsertConfigSnapshotAuditRecordInDatabase } from "./config-journal-snapshot.kernel.js";
import {
  patchConfigHealthEntryInDatabase,
  type ConfigHealthPatch,
} from "./io.health-state.kernel.js";
import type { ConfigHealthEntryBasis } from "./io.health-state.types.js";

export const configSnapshotOperations = {
  "config.health.patch": (
    input: {
      configPath: string;
      patch: ConfigHealthPatch;
      expected: ConfigHealthEntryBasis | null | undefined;
      updatedAtMs: number;
    },
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        patchConfigHealthEntryInDatabase(
          db,
          input.configPath,
          input.patch,
          input.expected,
          input.updatedAtMs,
        ),
      { ...stateOptions(), database: open() },
      { singleStatement: true },
    ),
  "config.snapshot.upsert": (
    input: Parameters<typeof upsertConfigSnapshotAuditRecordInDatabase>[1],
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => upsertConfigSnapshotAuditRecordInDatabase(db, input),
      { ...stateOptions(), database: open() },
    ),
} satisfies WorkerOperationHandlers;
