import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import type { WorkshopChange } from "./changes.kernel.js";

const MAX_CHANGES_LIMIT = 500;
type Store = { path: string; agents: Map<string, Promise<WorkshopChange[]>> };
const stores = resolveGlobalMap<string, Store>(
  Symbol.for("openclaw.skillWorkshopChanges"),
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

function captureStore() {
  const context = captureOpenClawStateWorkerContext();
  context.admission.assertCurrent();
  const key = context.admission.coordinationKey;
  let store = stores.get(key);
  if (!store) {
    store = { path: context.admission.identity.canonicalPath, agents: new Map() };
    stores.set(key, store);
  }
  return { context, store };
}

export async function recordWorkshopChange(change: WorkshopChange): Promise<void> {
  const { context, store } = captureStore();
  store.agents.delete(change.agentId);
  try {
    await executeOpenClawStateWorker(context, {
      type: "skills.workshop.changes.record",
      input: change,
    });
  } finally {
    // A lost acknowledgement may still follow a commit. Reload on the next read.
    store.agents.delete(change.agentId);
  }
}

export async function listWorkshopChanges(
  agentId: string,
  options: { limit?: number; beforeMs?: number; runId?: string } = {},
): Promise<WorkshopChange[]> {
  const { context, store } = captureStore();
  let rows = store.agents.get(agentId);
  if (!rows) {
    if (store.agents.size >= 128) {
      store.agents.delete(store.agents.keys().next().value!);
    }
    rows = executeOpenClawStateWorker(context, {
      type: "skills.workshop.changes.list",
      input: { agentId, limit: MAX_CHANGES_LIMIT },
    });
    store.agents.set(agentId, rows);
  }
  let changes: WorkshopChange[];
  try {
    changes = await rows;
  } catch (error) {
    if (store.agents.get(agentId) === rows) {
      store.agents.delete(agentId);
    }
    throw error;
  }
  context.admission.assertCurrent();
  return structuredClone(
    changes
      .filter(
        (change) =>
          (options.beforeMs === undefined || change.createdAtMs < options.beforeMs) &&
          (!options.runId || change.runId === options.runId),
      )
      .slice(0, Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), MAX_CHANGES_LIMIT)),
  );
}
