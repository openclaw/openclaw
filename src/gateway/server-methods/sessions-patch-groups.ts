import { groupPluginRecords as groupRecords } from "../../plugins/record-groups.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { isReadMarkerOnly } from "./session-unread-ack.js";
import type { PreparedPatchTarget } from "./sessions-patch-types.js";

export function resolveSessionPatchLifecycleTargets(targets: readonly PreparedPatchTarget[]) {
  return {
    kind: targets.every((target) => isReadMarkerOnly(target.fullPatch))
      ? ("read-marker" as const)
      : undefined,
    targets: targets.map((target) =>
      captureSessionTarget({
        storeScope: target.storePath,
        sessionKey: target.canonicalKey,
        aliases: target.lifecycleIdentities,
        incarnation: target.initialEntry?.sessionId,
        agentId: target.targetAgentId,
      }),
    ),
  };
}

/** Tree archival commits descendants before ancestors, including across physical stores. */
export async function runSessionPatchGroups(
  targets: readonly PreparedPatchTarget[],
  apply: (group: PreparedPatchTarget[]) => Promise<void>,
): Promise<void> {
  const ready = targets.filter(
    (target) => target.fullPatch.archived !== true || target.archivePreparation !== undefined,
  );
  if (
    ready.some(
      (target) =>
        target.fullPatch.archived === true &&
        target.fullPatch.expectedSidebarAncestors !== undefined,
    )
  ) {
    // Store grouping can reorder a mixed-agent tree even when the caller sends deepest-first.
    // Settle each descendant's commit before an ancestor changes the retained guard facts.
    for (const target of ready.toSorted(
      (a, b) =>
        (b.fullPatch.expectedSidebarAncestors?.length ?? 0) -
        (a.fullPatch.expectedSidebarAncestors?.length ?? 0),
    )) {
      await apply([target]);
    }
    return;
  }
  const groups = groupRecords(ready, (target) => target.storePath + "\0" + target.targetAgentId);
  await Promise.all([...groups.values()].map(apply));
}
