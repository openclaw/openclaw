import path from "node:path";
import { readPreparedSessionEntryPublicationSource } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { isSessionStoreTopologyChange, type SessionRowChange } from "./session-row-changes.js";

/** Locators cover absence; selected-source admission supplies physical identity before row reads. */
export function prepareSessionRowPublicationScope(
  paths: readonly string[],
  identity?: string | symbol,
) {
  const storePaths = new Set(
    paths.flatMap((pathname) => [
      path.resolve(pathname),
      resolveUnsuffixedSqliteTargetFromSessionStorePath(pathname).path,
    ]),
  );
  const databaseIdentities = new Set<string | symbol>(identity === undefined ? [] : [identity]);
  return {
    storePaths,
    databaseIdentities,
    prepareSource(database: { path: string }, source: DatabasePathIdentity) {
      storePaths.add(database.path);
      storePaths.add(source.canonicalPath);
      if (source.key.startsWith("file:")) {
        databaseIdentities.add(source.key.slice("file:".length));
      }
    },
  };
}

/** Stored rows have their own publication fence; display/runtime and auth refreshes do not replace them. */
export function sessionChangeAffectsStoredRow(
  change: SessionRowChange,
  target: {
    agentId?: string;
    sessionKeys: readonly string[];
    storePaths: ReadonlySet<string>;
    databaseIdentities: ReadonlySet<string | symbol>;
    ignoreStoreTopology?: boolean;
  },
): boolean {
  const source = readPreparedSessionEntryPublicationSource(change);
  const matchesStore = (storePath: string) =>
    source.identity !== undefined && target.databaseIdentities.size > 0
      ? target.databaseIdentities.has(source.identity)
      : target.storePaths.has(path.resolve(storePath)) ||
        (source.canonicalPath !== undefined && target.storePaths.has(source.canonicalPath));
  if ("all" in change) {
    if (target.ignoreStoreTopology && isSessionStoreTopologyChange(change)) {
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
        "config-presentation",
        "config-profiles",
        "runtime",
        "automation",
      ].includes(change.scope);
    }
    return change.scope.storePath
      ? matchesStore(change.scope.storePath)
      : !change.scope.agentId || change.scope.agentId === target.agentId;
  }
  // Entry/member writers name their physical store. Agent IDs alone can describe
  // a logical owner, so a physical publication must also reach cross-owner aliases.
  return (
    change.scope !== "automation" &&
    change.scope !== "runtime" &&
    change.scope !== "acp" &&
    change.storePath !== undefined &&
    matchesStore(change.storePath) &&
    target.sessionKeys.includes(change.sessionKey)
  );
}
