import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import {
  reviewObservation,
  type GitHubPublicationReviewChange,
  type GitHubPublicationReviewObservation,
  type GitHubPublicationReviewRow,
} from "./github-publication-review-store.types.js";

type View = {
  id: string;
  revision: object;
  value: Readonly<GitHubPublicationReviewObservation> | undefined;
  pending: Set<Promise<void>>;
  uncertain: boolean;
};
type Store = { path: string; views: Map<string, WeakRef<View>> };
const stores = resolveGlobalMap<string, Store>(
  Symbol.for("openclaw.publicationReviewViews"),
  "close-and-restart",
);
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") {
    return;
  }
  for (const [key, store] of stores) {
    if (store.path === (event.identity?.canonicalPath ?? event.path)) {
      stores.delete(key);
    }
  }
});
function owner(admission: OpenClawStateDatabaseReadAdmission) {
  admission.assertCurrent();
  let store = stores.get(admission.coordinationKey);
  if (!store) {
    store = { path: admission.identity.canonicalPath, views: new Map() };
    stores.set(admission.coordinationKey, store);
  }
  return store;
}
function viewFor(store: Store, id: string): View {
  for (const [key, reference] of store.views) {
    if (!reference.deref()) {
      store.views.delete(key);
    }
  }
  let view = store.views.get(id)?.deref();
  if (!view) {
    view = { id, revision: {}, value: undefined, pending: new Set(), uncertain: false };
    store.views.set(id, new WeakRef(view));
  }
  return view;
}
/** Only prepared confirmations retain observations; historical rows and diff bytes are not cached. */
export async function prepareGitHubPublicationReviewRead(
  admission: OpenClawStateDatabaseReadAdmission,
  reviewId: string,
  read: () => Promise<GitHubPublicationReviewRow | undefined>,
) {
  const store = owner(admission);
  const view = viewFor(store, reviewId);
  const assertSource = () => {
    admission.assertCurrent();
    if (stores.get(admission.coordinationKey) !== store) {
      throw new Error("Publication review database owner changed");
    }
  };
  for (;;) {
    if (view.pending.size) {
      await Promise.all(view.pending);
    }
    assertSource();
    const revision = view.revision;
    const row = await read();
    assertSource();
    if (revision !== view.revision || view.pending.size) {
      continue;
    }
    view.value = row && Object.freeze(reviewObservation(row));
    view.uncertain = false;
    return {
      row,
      current() {
        assertSource();
        if (view.pending.size || view.uncertain) {
          throw new Error("Publication review mutation has not settled; refresh this candidate");
        }
        return view.value;
      },
    };
  }
}
/**
 * Stage after authority checks, before the native commit grant. The canonical
 * SQLite broker settles each job before admitting the next writer to this owner.
 */
export function stageGitHubPublicationReviewChanges(
  admission: OpenClawStateDatabaseReadAdmission,
  changes: readonly GitHubPublicationReviewChange[],
) {
  const store = owner(admission);
  const byId = new Map(changes.map((change) => [change.reviewId, change]));
  const pending = createDeferredCore();
  const revision = {};
  // Staging retains missing views too, so a reader arriving before settlement joins the fence.
  const affected = [...byId.keys()].map((id) => viewFor(store, id));
  for (const view of affected) {
    view.revision = revision;
    view.pending.add(pending.promise);
  }
  let settled = false;
  return {
    settle(committed: boolean, known: boolean) {
      if (settled) {
        return;
      }
      settled = true;
      for (const view of affected) {
        if (stores.get(admission.coordinationKey) === store && view.revision === revision) {
          if (committed) {
            const row = byId.get(view.id)!.row;
            view.value = row && Object.freeze({ ...row });
          }
          view.uncertain = !known;
        }
        view.pending.delete(pending.promise);
      }
      pending.resolve();
    },
  };
}
