import { isDeepStrictEqual } from "node:util";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionProviderReviewComparison } from "./provider-review.types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type { SessionEntry } from "./types.js";

export function compareSessionProviderReviewInWorker(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: SessionProviderReviewComparison,
  admit: (
    stage: "transaction" | "commit",
    publication?: SessionEntryReplacementPublication,
  ) => void,
): { entry: SessionEntry; publication: SessionEntryReplacementPublication } {
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Provider review lost its canonical database owner");
      }
      admit("transaction");
      const entry = readExactSessionEntryRow(current, input.sessionKey)?.entry;
      if (
        !entry ||
        entry.sessionId !== input.sessionId ||
        entry.lifecycleRevision !== input.lifecycleRevision ||
        !isDeepStrictEqual(entry.providerReview, input.expectedReview) ||
        (input.nextReview && input.nextReview.sessionId !== input.sessionId)
      ) {
        throw new Error("Provider review changed; refresh the findings before continuing");
      }
      const next = { ...entry, providerReview: input.nextReview };
      const updated = writeSessionEntry(current, input.sessionKey, next, {
        canonicalPreviousEntry: entry,
        providerReviewMutation: true,
      });
      const publication = prepareSessionEntryReplacementPublication(
        {
          pendingArchiveRecovery: false,
          previous: new Map([[input.sessionKey, entry]]),
          current: new Map([[input.sessionKey, updated]]),
          maintenancePlans: [],
          membershipInvalidatedKeys: [],
        },
        current,
      );
      deferSqliteWorkerCommitReceipt(current.db, publication);
      admit("commit", publication);
      return { entry: updated, publication };
    },
    options,
    { operationLabel: "session.provider-review.compare" },
  );
}
