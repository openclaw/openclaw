import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { createOpenClawAgentDatabasePathMatcher } from "../../state/openclaw-agent-db.paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  readSessionStoreRegistryRows,
  resolveSqliteTargetFromSessionStorePath,
  type ResolvedSqliteStoreTarget,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import type { SessionStoreReadCandidate } from "./session-store-read-candidates.js";

/** One session store path paired with its owning agent id. */
export type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

type SessionStoreTargetCollisionDiagnostic = {
  message: string;
  sqlitePath: string;
  ownerAgentId?: string;
  ignoredAgentIds: string[];
  ownerSource: NonNullable<ResolvedSqliteStoreTarget["ownerSource"]>;
};

const log = createSubsystemLogger("sessions/targets");

export function dedupeSessionStoreTargetsBySqliteTarget(
  targets: SessionStoreTarget[],
  options: {
    defaultAgentId: string;
    env?: NodeJS.ProcessEnv;
    registeredDatabases?: SessionStoreRegistryRead;
    readCandidates?: readonly SessionStoreReadCandidate[];
    onDiagnostic?: (diagnostic: SessionStoreTargetCollisionDiagnostic) => void;
    onSharedTarget?: (selected: SessionStoreTarget, sharedStorePaths: ReadonlySet<string>) => void;
    onResolvedTarget?: (selected: SessionStoreTarget, physical: SessionStoreTarget) => void;
  },
): SessionStoreTarget[] {
  let registeredDatabases: ReturnType<typeof readSessionStoreRegistryRows> | undefined;
  const readRegistry = () =>
    (registeredDatabases ??= readSessionStoreRegistryRows(
      options.registeredDatabases,
      options.env,
    ));
  const reportDiagnostic = (diagnostic: SessionStoreTargetCollisionDiagnostic) => {
    if (options.onDiagnostic) {
      options.onDiagnostic(diagnostic);
    } else {
      log.warn(diagnostic.message);
    }
  };
  const grouped = new Map<
    string,
    Array<{ target: SessionStoreTarget; databaseOwnerAgentId?: string; shared: boolean }>
  >();
  const logicalGroups = new Map<
    string,
    Array<{
      target: SessionStoreTarget;
      ownerSource?: SessionStoreTargetCollisionDiagnostic["ownerSource"];
      unsuffixedOwnerAgentId?: string;
    }>
  >();
  // Alias targets can change between calls. Reuse prepared identities only for this
  // synchronous dedupe invocation so collision ownership never relies on stale paths.
  const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
  const physicalGroupKey = isSameDatabasePath.createIndex();
  const logicalGroupKey = isSameDatabasePath.createIndex();
  const resolveGroupKey = (
    groups: ReadonlyMap<string, unknown>,
    key: (pathname: string) => string,
    pathname: string,
  ) => {
    // A singleton group needs no additional physical inspection.
    if (groups.size === 0) {
      return path.resolve(pathname);
    }
    if (groups.size === 1) {
      key(groups.keys().next().value!);
    }
    return key(pathname);
  };
  for (const target of targets) {
    const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId: target.agentId,
      defaultAgentId: options.defaultAgentId,
      env: options.env,
      get registeredDatabases() {
        return readRegistry();
      },
      isSameDatabasePath,
      readCandidates: options.readCandidates,
    });
    const sqlitePath = resolveGroupKey(grouped, physicalGroupKey, resolved.path);
    const group = grouped.get(sqlitePath) ?? [];
    group.push({
      target,
      shared: resolved.shared === true,
      ...(resolved.agentId ? { databaseOwnerAgentId: resolved.agentId } : {}),
    });
    grouped.set(sqlitePath, group);
    // Exact shared locators do not allocate legacy per-agent suffixes.
    if (resolved.shared) {
      continue;
    }
    const resolvedUnsuffixedPath = path.resolve(
      resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).path,
    );
    const unsuffixedPath = resolveGroupKey(logicalGroups, logicalGroupKey, resolvedUnsuffixedPath);
    const logicalGroup = logicalGroups.get(unsuffixedPath) ?? [];
    logicalGroup.push({
      target,
      ...(resolved.ownerSource ? { ownerSource: resolved.ownerSource } : {}),
      ...(resolved.unsuffixedOwnerAgentId
        ? { unsuffixedOwnerAgentId: resolved.unsuffixedOwnerAgentId }
        : {}),
    });
    logicalGroups.set(unsuffixedPath, logicalGroup);
  }
  for (const [sqlitePath, group] of logicalGroups) {
    const agentIds = [...new Set(group.map(({ target }) => normalizeAgentId(target.agentId)))];
    if (agentIds.length <= 1 || group.some((entry) => !entry.ownerSource)) {
      continue;
    }
    const ownerAgentId = group[0]?.unsuffixedOwnerAgentId;
    const ownerSource = group[0]?.ownerSource ?? "configured-default";
    const ignoredAgentIds = ownerAgentId
      ? agentIds.filter((agentId) => agentId !== ownerAgentId)
      : agentIds;
    const diagnostic: SessionStoreTargetCollisionDiagnostic = {
      message: ownerAgentId
        ? `Session store target collision at ${sqlitePath}: owner "${ownerAgentId}" selected by ${ownerSource}; suffixed owner(s): ${ignoredAgentIds.map((id) => `"${id}"`).join(", ")}.`
        : ownerSource === "registered-suffixed"
          ? `Session store target collision at ${sqlitePath}: configured default retains its registered suffixed target; all claimant(s) use suffixed targets: ${ignoredAgentIds.map((id) => `"${id}"`).join(", ")}.`
          : ownerSource === "occupied-unsuffixed"
            ? `Session store target collision at ${sqlitePath}: unsuffixed target is occupied without a durable owner; all claimant(s) use suffixed targets: ${ignoredAgentIds.map((id) => `"${id}"`).join(", ")}.`
            : `Session store target collision at ${sqlitePath}: registry ownership is ambiguous; all claimant(s) use suffixed targets: ${ignoredAgentIds.map((id) => `"${id}"`).join(", ")}.`,
      sqlitePath,
      ...(ownerAgentId ? { ownerAgentId } : {}),
      ignoredAgentIds,
      ownerSource,
    };
    reportDiagnostic(diagnostic);
  }
  const deduped: SessionStoreTarget[] = [];
  for (const [sqlitePath, group] of grouped) {
    const byAgentId = new Map(
      group.map(({ target }) => [normalizeAgentId(target.agentId), target] as const),
    );
    const pathOwners = [...new Set(group.flatMap((entry) => entry.databaseOwnerAgentId ?? []))];
    // Canonical paths already name their owner. Only ambiguous ownership needs
    // registry admission; fixed/shared locators also require it in the resolver above.
    const registeredOwners =
      pathOwners.length === 1
        ? []
        : [
            ...new Set(
              readRegistry()
                .filter((entry) => isSameDatabasePath(entry.path, sqlitePath))
                .map((entry) => normalizeAgentId(entry.agentId)),
            ),
          ];
    const collision = byAgentId.size > 1;
    if (pathOwners.length !== 1 && registeredOwners.length > 1) {
      const diagnostic: SessionStoreTargetCollisionDiagnostic = {
        message: `Session store target collision at ${sqlitePath}: registry ownership is ambiguous across ${registeredOwners.map((id) => `"${id}"`).join(", ")}; no owner selected.`,
        sqlitePath,
        ignoredAgentIds: [...byAgentId.keys()],
        ownerSource: "ambiguous-registry",
      };
      reportDiagnostic(diagnostic);
      continue;
    }
    const ownerSource =
      pathOwners.length === 1
        ? "database-path"
        : registeredOwners.length === 1
          ? "database-registry"
          : "configured-default";
    const ownerAgentId = normalizeAgentId(
      pathOwners[0] ??
        registeredOwners[0] ??
        (collision ? options.defaultAgentId : group[0]!.target.agentId),
    );
    const ownerTarget = byAgentId.get(ownerAgentId);
    // An exact shared database can outlive its schema owner's roster entry. Keep one
    // configured claimant so the accessor can reopen the path under its durable owner.
    const selected =
      ownerTarget ??
      (group.some((entry) => entry.shared)
        ? (byAgentId.get(normalizeAgentId(options.defaultAgentId)) ?? group[0]?.target)
        : undefined);
    if (selected) {
      deduped.push(selected);
      options.onResolvedTarget?.(selected, { agentId: ownerAgentId, storePath: sqlitePath });
      if (options.onSharedTarget) {
        // A shared alias can select a per-agent registry spelling. Preserve its
        // original shared claims so consumers need no second ownership scan.
        const sharedStorePaths = new Set(
          group.filter((entry) => entry.shared).map((entry) => entry.target.storePath),
        );
        if (sharedStorePaths.size > 0) {
          options.onSharedTarget(selected, sharedStorePaths);
        }
      }
    }
    const selectedAgentId = selected ? normalizeAgentId(selected.agentId) : ownerAgentId;
    const ignoredAgentIds = [...byAgentId.keys()].filter((agentId) => agentId !== selectedAgentId);
    if (!selected || ignoredAgentIds.length > 0) {
      const effectiveIgnoredAgentIds = selected ? ignoredAgentIds : [...byAgentId.keys()];
      const diagnostic: SessionStoreTargetCollisionDiagnostic = {
        message: `Session store target collision at ${sqlitePath}: owner "${ownerAgentId}" selected by ${ownerSource}; ignored owner(s): ${effectiveIgnoredAgentIds.map((id) => `"${id}"`).join(", ")}.`,
        sqlitePath,
        ownerAgentId,
        ignoredAgentIds: effectiveIgnoredAgentIds,
        ownerSource,
      };
      reportDiagnostic(diagnostic);
    }
  }
  return deduped;
}
