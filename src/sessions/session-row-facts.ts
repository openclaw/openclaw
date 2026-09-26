import type { SessionRowChange } from "./session-row-changes.js";

/** Stored rows have their own publication fence; display/runtime and auth refreshes do not replace them. */
export function sessionChangeAffectsStoredRow(
  change: SessionRowChange,
  target: {
    agentId?: string;
    sessionKeys: readonly string[];
    ignoreStoreTopology?: boolean;
  },
): boolean {
  if ("all" in change) {
    if (change.scope === "stores" && target.ignoreStoreTopology) {
      return false;
    }
    if (typeof change.scope === "string") {
      // Profiles still refresh authorization at its owner, independently of row freshness.
      return ![
        "profiles",
        "catalog",
        "acp",
        "agent-runs",
        "subagent-runs",
        "worker-placements",
        "worker-environments",
        "config",
        "runtime",
        "automation",
      ].includes(change.scope);
    }
    return (
      !change.scope.agentId ||
      change.scope.agentId === target.agentId ||
      Boolean(change.scope.storePath)
    );
  }
  // Entry/member writers name their physical store. Agent IDs alone can describe
  // a logical owner, so a physical publication must also reach cross-owner aliases.
  return (
    change.scope !== "automation" &&
    change.scope !== "runtime" &&
    Boolean(change.storePath) &&
    target.sessionKeys.includes(change.sessionKey)
  );
}
