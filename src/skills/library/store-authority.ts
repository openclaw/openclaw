import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "../../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateReadContext } from "../../state/openclaw-state-worker-context.js";
import { SkillLibraryError } from "../skill-library-error.js";

type Store = { path: string; revision: object; pending: number };
const stores = resolveGlobalMap<string, Store>(
  Symbol.for("openclaw.skillLibraryAuthority"),
  "close-and-restart",
);
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    for (const [key, store] of stores) {
      if (store.path === (event.identity?.canonicalPath ?? event.path)) {
        stores.delete(key);
      }
    }
  }
});
function owner(admission: OpenClawStateDatabaseReadAdmission) {
  admission.assertCurrent();
  let store = stores.get(admission.coordinationKey);
  if (!store) {
    store = { path: admission.identity.canonicalPath, revision: {}, pending: 0 };
    stores.set(admission.coordinationKey, store);
  }
  return store;
}

/** No rows are cached: a prepared selection is valid only through its writer's committed revision. */
export function captureSkillLibraryAuthorityRead(admission: OpenClawStateDatabaseReadAdmission) {
  const store = owner(admission);
  const revision = store.revision;
  const assertCurrent = () => {
    admission.assertCurrent();
    if (
      stores.get(admission.coordinationKey) !== store ||
      store.revision !== revision ||
      store.pending
    ) {
      throw new SkillLibraryError(
        "CONFLICT",
        "Skill library access changed during preparation. Refresh and retry.",
      );
    }
  };
  assertCurrent();
  return { assertCurrent };
}

/** Native writers fence pending changes; outer COMMIT publishes before observers, rollback preserves eligibility. */
export function stageSkillLibraryAuthorityChange(db: DatabaseSync) {
  const location = db.location();
  if (!location) {
    throw new Error("Skill library requires its durable database owner");
  }
  const store = owner(captureOpenClawStateReadContext(location).admission);
  if (
    !stageSqliteTransactionState(db, {
      stage: () => {
        store.pending += 1;
      },
      commit: () => {
        store.revision = {};
        store.pending -= 1;
      },
      rollback: () => {
        store.pending -= 1;
        try {
          assertTransactionUsable(db);
        } catch {
          // The native owner cannot prove rollback after a lost COMMIT outcome.
          store.revision = {};
        }
      },
    })
  ) {
    throw new Error("Skill library publication requires its native transaction owner");
  }
}
