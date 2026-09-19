import type { SessionRowReadView } from "./session-row-prepared-read.js";
import * as records from "./session-row-projection-record.js";

/** Follow the projection's physical lineage and aggregate owners without a roster scan. */
export function readSessionRowAncestors(
  record: records.MaterializedRow,
  owner: {
    cfg: records.Inputs["cfg"];
    context: SessionRowReadView["state"]["rowContext"];
    referenced: (reference: string) => records.Row | undefined;
    describe: SessionRowReadView["describe"];
  },
): records.MaterializedRow[] | undefined {
  const seen = new Set([records.identity(record)]);
  const pending = [record];
  const ancestors: records.MaterializedRow[] = [];
  for (const child of pending) {
    const parents = new Set(child.parents);
    for (const run of owner.context.subagentRunsByChildSessionKey.get(child.key) ?? []) {
      // Requester rollups and collector summaries can belong to different controllers.
      for (const key of [run.requesterSessionKey, run.swarmRequesterSessionKey]) {
        if (key) {
          const agentId = run.requesterAgentId ?? child.agentId;
          parents.add(
            records.parentReference(
              owner.cfg,
              key,
              agentId,
              agentId === child.agentId ? child.storeTarget.storePath : undefined,
            ),
          );
        }
      }
    }
    for (const ref of parents) {
      const parent = owner.referenced(ref);
      // A missing intermediary can still have registry-owned ancestors and rollups.
      if (!parent) {
        return undefined;
      }
      if (seen.has(records.identity(parent))) {
        continue;
      }
      // Omission makes clients refresh rather than accepting a partial tree.
      if (ancestors.length === 64) {
        return undefined;
      }
      seen.add(records.identity(parent));
      const prepared = owner.describe(
        { ...parent, storePath: parent.storeTarget.storePath },
        parent,
      );
      if (!prepared) {
        return undefined;
      }
      ancestors.push(prepared);
      pending.push(prepared);
    }
  }
  return ancestors;
}
