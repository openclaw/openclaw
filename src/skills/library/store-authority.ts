import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "../../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../../state/openclaw-state-db-cache.js";
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

/** Fence before granting COMMIT; publish inside the writer FIFO after native settlement. */
export function fenceSkillLibraryMutationAuthority(admission: OpenClawStateDatabaseReadAdmission) {
  const store = owner(admission);
  store.pending += 1;
  let settled = false;
  return (outcome: "committed" | "rolled-back" | "unknown") => {
    if (settled) {
      return;
    }
    settled = true;
    store.pending -= 1;
    // Only a confirmed rollback preserves an earlier prepared selection.
    if (outcome !== "rolled-back") {
      store.revision = {};
    }
  };
}
