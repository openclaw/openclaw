import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveGatewaySessionStoreTargets } from "../config/sessions/combined-store-gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import * as records from "./session-row-projection-record.js";

type SessionRowScopeTarget = {
  agentId: string;
  storeTarget: { agentId: string; storePath: string };
};
type SessionRowScopeQuery = { agentId?: string; storePath?: string };
type SessionRowScope =
  | Pick<ReturnType<typeof prepareSessionRowScopes>, "physicalPaths">
  | undefined;

/** Early publications retain literal paths until topology has prepared their aliases. */
export function createSessionRowScopeMatcher(
  query: SessionRowScopeQuery,
  scope: SessionRowScope,
  logicalOwnerOnly = false,
) {
  const paths = query.storePath
    ? (scope?.physicalPaths(query.storePath, query.agentId) ?? [query.storePath])
    : undefined;
  return (row: SessionRowScopeTarget) =>
    (!query.agentId ||
      row.agentId === query.agentId ||
      (!logicalOwnerOnly && row.storeTarget.agentId === query.agentId)) &&
    (!paths || paths.includes(row.storeTarget.storePath));
}

export function selectMatchingSessionRows<T extends SessionRowScopeTarget>(
  params: {
    rows: ReadonlyMap<string, T>;
    indexes: {
      byKey: ReadonlyMap<string, ReadonlySet<string>>;
      byStore: ReadonlyMap<string, ReadonlySet<string>>;
      byAgent: ReadonlyMap<string, ReadonlySet<string>>;
    };
    scope: SessionRowScope;
  },
  query: SessionRowScopeQuery & { key?: string },
  kind = "key",
) {
  const {
    rows,
    indexes: { byKey, byStore, byAgent },
    scope,
  } = params;
  const storePaths =
    !query.key && query.storePath
      ? (scope?.physicalPaths(query.storePath, query.agentId) ?? [query.storePath])
      : undefined;
  const candidates = query.key
    ? byKey.get(`${kind}:${query.key}`)
    : storePaths
      ? storePaths.length === 1
        ? byStore.get(storePaths[0]!)
        : new Set(storePaths.flatMap((storePath) => Array.from(byStore.get(storePath) ?? [])))
      : query.agentId
        ? byAgent.get(query.agentId)
        : rows.keys();
  if (!candidates) {
    return [];
  }
  const matches = createSessionRowScopeMatcher(query, scope);
  const selected: T[] = [];
  for (const id of candidates) {
    const row = rows.get(id);
    if (row !== undefined && matches(row)) {
      selected.push(row);
    }
  }
  return selected;
}

/** Resolve query-specific federation once when the physical topology is published. */
export function prepareSessionRowScopes(
  cfg: OpenClawConfig,
  agentIds: Iterable<string>,
  residentPaths: ReadonlyMap<string, string>,
) {
  const residentPath = (pathname: string) => residentPaths.get(pathname) ?? pathname;
  const filenames = new Map([...residentPaths].map(([filename, locator]) => [locator, filename]));
  const aliases = new Map<string, Map<string, string>>();
  const capture = (options: { agentId?: string; configuredAgentsOnly?: boolean }) => {
    try {
      const resolved = resolveGatewaySessionStoreTargets(cfg, {
        ...options,
        includeIncognito: false,
      });
      for (const [identity, physical] of resolved.physicalTargets) {
        const separator = identity.indexOf("\0");
        const agentId = identity.slice(0, separator);
        const locator = path.resolve(identity.slice(separator + 1));
        const owners = aliases.get(locator) ?? new Map<string, string>();
        owners.set(agentId, residentPath(physical.storePath));
        aliases.set(locator, owners);
      }
      const paths = resolved.durableTargets.map((target) =>
        residentPath(
          expectDefined(
            resolved.physicalTargets.get(`${target.agentId}\0${target.storePath}`),
            "physical source",
          ).storePath,
        ),
      );
      return {
        paths: new Map(paths.map((pathname, index) => [pathname, index])),
        path: paths.length === 1 ? (filenames.get(paths[0]!) ?? paths[0]!) : "(multiple)",
        configuredAgentIds: resolved.configuredAgentIds,
        agentId: resolved.requestedAgentId,
      };
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const all = capture({});
  const configured = capture({ configuredAgentsOnly: true });
  const agents = new Map(
    [...new Set([...listAgentIds(cfg), ...agentIds])].map((agentId) => [
      agentId,
      capture({ agentId }),
    ]),
  );
  const select = (options: { agentId?: string; configuredAgentsOnly?: boolean }) => {
    const requestedAgentId = options.agentId?.trim()
      ? normalizeAgentId(options.agentId)
      : undefined;
    const scope = requestedAgentId
      ? (agents.get(requestedAgentId) ?? {
          paths: new Map<string, number>(),
          path: "(multiple)",
          agentId: requestedAgentId,
          configuredAgentIds: undefined,
        })
      : options.configuredAgentsOnly
        ? configured
        : all;
    if (scope instanceof Error) {
      throw scope;
    }
    return scope;
  };
  return {
    select,
    physicalPaths(locator: string, agentId?: string) {
      // Resident physical locators were normalized when the topology was prepared.
      const normalized = filenames.has(locator) ? locator : residentPath(path.resolve(locator));
      const owners = aliases.get(normalized);
      return agentId
        ? [owners?.get(normalizeAgentId(agentId)) ?? normalized]
        : owners
          ? [...new Set(owners.values())]
          : [normalized];
    },
  };
}

/** Select metadata before federation, visibility, and reader-only materialization. */
export function selectSessionRowEntries(
  params: {
    cfg: OpenClawConfig;
    scope: SessionRowScope;
    byAgent: ReadonlyMap<string, ReadonlySet<string>>;
    byParent: ReadonlyMap<string, ReadonlySet<string>>;
    rows: ReadonlyMap<string, records.Row>;
    dirty: ReadonlySet<string>;
    matching: (query: records.Query, kind?: string) => records.Row[];
    acquire: (row: records.Row) => records.Row | undefined;
  },
  query: records.Query,
) {
  const { cfg, scope, byAgent, byParent, rows, dirty, matching, acquire } = params;
  const matches = createSessionRowScopeMatcher(query, scope, true);
  const parent = query.parentSessionKey;
  const owner = parent && parseAgentSessionKey(parent)?.agentId;
  const agents = owner ? [owner] : query.agentId ? [query.agentId] : byAgent.keys();
  const children = new Set<string>();
  if (parent) {
    for (const ref of [
      ...[...agents].map((agentId) => records.parentReference(cfg, parent, agentId)),
      ...matching({ ...query, key: parent }).map((row) =>
        records.physical(row.storeTarget.storePath, parent),
      ),
    ]) {
      for (const id of byParent.get(ref) ?? []) {
        children.add(id);
      }
    }
  }
  const sessionIdOrKey = query.sessionIdOrKey;
  let keys: Set<string> | undefined;
  if (sessionIdOrKey) {
    // Broad publications can change IDs before the resident index has caught up.
    for (const id of dirty) {
      const row = rows.get(id);
      if (row && matches(row)) {
        acquire(row);
      }
    }
    const indexed = { ...query, key: sessionIdOrKey };
    keys = new Set([...matching(indexed, "id"), ...matching(indexed)].map((row) => row.key));
  }
  // Keep every physical competitor; federation precedes ID and visibility filtering.
  const candidates = keys
    ? [...keys].flatMap((key) => matching({ ...query, key }))
    : parent
      ? [...children].map((id) => rows.get(id))
      : matching(query);
  const acquired =
    sessionIdOrKey || dirty.size === 0
      ? candidates
      : candidates.map((row) => (row && dirty.has(records.identity(row)) ? acquire(row) : row));
  const selected = acquired.filter(
    (row): row is records.EntryRow => records.hasEntry(row) && matches(row),
  );
  return records.sort(selected, query.sortBy);
}
