import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import {
  createMentionProjection,
  expireMentionItems,
  reconcileMentionProfiles,
  serializeMentionSource,
  type InboxState,
} from "./mention-inbox-projection.js";
import { readMentionStoreSnapshot, writeMentionStoreChanges } from "./mention-inbox-store.js";

// Released 2026.9.8 SDK calls stay synchronous until the next Plugin SDK major.
export function mutateNativeMentionSnapshot(
  context: OpenClawStateWorkerContext,
  params: {
    now: () => number;
    canonicalProfileId: (id: string) => string;
    apply: (draft: InboxState) => void;
    publish: (draft: InboxState) => void;
    notify: () => void;
  },
): InboxState {
  context.admission.assertCurrent();
  return runWithSqliteWorkerStateContext(context, () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const snapshot = readMentionStoreSnapshot(-1, db);
        if (!snapshot) {
          throw new Error("Mention snapshot is unavailable inside its transaction");
        }
        const draft = createMentionProjection(snapshot);
        expireMentionItems(draft, params.now());
        reconcileMentionProfiles(draft, readUserProfileVersion(), params.canonicalProfileId);
        params.apply(draft);
        const changes = new Map(
          [...draft.dirtySources].map((key) => {
            const source = draft.processed.get(key);
            return [key, source ? serializeMentionSource(source) : undefined] as const;
          }),
        );
        draft.head = writeMentionStoreChanges(db, draft.head, changes);
        draft.dirtySources.clear();
        stageSqliteTransactionState(db, {
          stage: () => {},
          rollback: () => {},
          commit: () => params.publish(draft),
          prepareObservers: params.notify,
        });
        return draft;
      },
      { path: context.admission.databasePath, env: context.environment },
      { operationLabel: "mentions.sdk.write" },
    ),
  );
}
