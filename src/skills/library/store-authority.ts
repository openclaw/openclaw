import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "../../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../../state/openclaw-state-db-cache.js";
import { readUserProfileVersion } from "../../state/user-profile-events.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillLibraryReadOutput } from "./read.contract.js";

type CachedReply = SkillLibraryReadOutput & { ok: true };
type CachedRead = {
  value: CachedReply;
  profileVersion: number;
  profilesCurrent: () => boolean;
};
type Store = {
  path: string;
  revision: object;
  pending: number;
  reads: Map<string, CachedRead>;
};
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
    store = { path: admission.identity.canonicalPath, revision: {}, pending: 0, reads: new Map() };
    stores.set(admission.coordinationKey, store);
  }
  return store;
}

/** Read facts and prepared selections share the owning writer's committed revision. */
export function captureSkillLibraryAuthorityRead(admission: OpenClawStateDatabaseReadAdmission) {
  const store = owner(admission);
  const revision = store.revision;
  const profileVersion = readUserProfileVersion();
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
  return {
    assertCurrent,
    read(key: string): CachedReply | undefined {
      assertCurrent();
      const cached = store.reads.get(key);
      if (!cached) {
        return undefined;
      }
      if (cached.profileVersion !== readUserProfileVersion() || !cached.profilesCurrent()) {
        store.reads.delete(key);
        return undefined;
      }
      return structuredClone(cached.value);
    },
    remember(key: string, value: CachedReply, profilesCurrent: () => boolean): void {
      assertCurrent();
      if (profileVersion !== readUserProfileVersion()) {
        return;
      }
      // Bound arbitrary query parameters and retain caller-owned result objects.
      if (store.reads.size >= 128) {
        store.reads.delete(store.reads.keys().next().value!);
      }
      store.reads.set(key, {
        value: structuredClone(value),
        profileVersion,
        profilesCurrent,
      });
    },
  };
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
      store.reads.clear();
    }
  };
}
