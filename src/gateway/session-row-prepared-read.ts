import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareProjectedAgentRunProgressState } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { PreparedRepositoryWorkspace } from "../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import type { createSessionRowChildActivity } from "./session-row-child-activity.js";
import type { createSessionRowChildVisibility } from "./session-row-child-visibility.js";
import * as records from "./session-row-projection-record.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import {
  projectGatewaySessionRunState,
  type GatewaySessionRunStateCache,
} from "./session-utils-display.js";

type SessionRunSource = Pick<
  records.MaterializedRow["materialized"]["source"],
  "entry" | "parsedKey"
>;
const preparedRunStates = new WeakMap<
  SessionRunSource,
  {
    progress: ReturnType<typeof prepareProjectedAgentRunProgressState>;
    cache: GatewaySessionRunStateCache;
  }
>();

/** Each immutable materialized source belongs to one key; replacement retires its query. */
export function projectPreparedSessionRunState(
  key: string,
  source: SessionRunSource,
  now: number,
  rowContext: Parameters<typeof projectGatewaySessionRunState>[0]["rowContext"],
) {
  let prepared = preparedRunStates.get(source);
  if (!prepared) {
    prepared = {
      progress: prepareProjectedAgentRunProgressState({
        sessionKeys: [key],
        sessionId: source.entry?.sessionId,
        agentId: source.parsedKey?.agentId ?? "",
      }),
      cache: {},
    };
    preparedRunStates.set(source, prepared);
  }
  return projectGatewaySessionRunState({
    key,
    entry: source.entry,
    parsedKey: source.parsedKey,
    now,
    rowContext,
    projectRunProgress: prepared.progress,
    cache: prepared.cache,
  });
}

export function toProjectedSessionSharingTarget(
  record: records.MaterializedRow,
): SessionSharingTarget {
  return {
    agentId: record.agentId,
    canonicalKey: record.key,
    entry: record.entry,
    storeKey: record.key,
    storeKeys: [record.key],
    storePath: record.storeTarget.storePath,
  };
}

export type SessionRowSelectionPreparationOptions = {
  metadataOnly?: boolean;
  includeCatalog?: boolean;
  requireCurrentCatalog?: boolean;
  catalogSignal?: AbortSignal;
};

export type SessionRowPreparationOptions = {
  includeAncestors?: boolean;
  /** Queries select canonical durable roster keys; private exact reads use the default path. */
  selection?: boolean | SessionRowSelectionPreparationOptions;
};

/** Synchronous selection reenters through the existing exact worker preparation owner. */
export class SessionRowFactsPending extends Error {
  constructor(readonly queries: readonly records.Lookup[]) {
    super("Session row facts require worker reconciliation");
  }
}

/** Only failed row materialization can request a catalog rebind, never its consumer. */
export class SessionRowCatalogPending extends Error {
  constructor() {
    // RPC formatters include causes; keep model-facing plugin errors out of the response.
    super("Session model catalog is unavailable; refresh and try again.");
  }
}

export type SessionRowReadView = {
  readChildVisibility: ReturnType<typeof createSessionRowChildVisibility>["read"];
  readChildActivity(
    record: records.MaterializedRow,
    now: number,
    excluded?: ReadonlySet<string>,
    exclusionRevision?: object,
  ): ReturnType<ReturnType<typeof createSessionRowChildActivity>["read"]>;
  describe(
    query: records.Lookup,
    captured?: records.Row,
    repositoryWorkspace?: Readonly<SessionRepositoryWorkspaceRecord> | null,
  ): records.MaterializedRow | undefined;
  readSource(row: records.MaterializedRow): CapturedSessionEntryReadSource | undefined;
  readMembership(query: records.Lookup): ReadonlySet<string> | undefined;
  present(
    record: records.MaterializedRow,
    options?: records.SnapshotOptions,
  ): ReturnType<typeof records.present>;
  selectEntries(query: { key: string }): records.EntryRow[];
  readonly physicalPaths: (locator: string, agentId?: string) => readonly string[];
  readonly state: Readonly<{
    cfg: OpenClawConfig;
    policyConfig: OpenClawConfig;
    rowContext: SessionListRowContext;
  }>;
};

export type PreparedPrivateSessionRepository = {
  row: records.Row;
  workspaceId: string;
  repository: PreparedRepositoryWorkspace;
};

export function privateSessionRowReadKey(cfg: OpenClawConfig, query: records.Lookup) {
  const key = resolveStoredSessionKeyForAgentStore({
    cfg,
    agentId: query.agentId,
    sessionKey: query.key,
  });
  return isIncognitoSessionKey(key) ? JSON.stringify([query.agentId, key]) : undefined;
}

export function readPreparedSessionRows<T>(
  owner: SessionRowReadView & {
    isCurrent(row: records.Row): boolean;
    getPolicyConfig(): OpenClawConfig;
  },
  isActive: () => boolean,
  queries: (config: OpenClawConfig) => readonly records.Lookup[],
  consume: (read: SessionRowReadView) => T,
  privateRepositories?: ReadonlyMap<string, PreparedPrivateSessionRepository>,
  capturedPrivateRows?: ReadonlyMap<string, records.Row | undefined>,
) {
  if (!isActive()) {
    throw new Error("Session row read view is no longer active");
  }
  // Durable facts were admitted by the worker owner; private rows use the memory actor.
  let state = owner.state;
  const privateRows = new Map<string, records.MaterializedRow | undefined>();
  const childSelections = new Map<string, records.EntryRow[]>();
  const privateKey = (query: records.Lookup) => privateSessionRowReadKey(state.cfg, query);
  for (const query of queries(state.cfg)) {
    const key = privateKey(query);
    if (key && !privateRows.has(key)) {
      const prepared = privateRepositories?.get(key);
      const row = capturedPrivateRows?.has(key)
        ? capturedPrivateRows.get(key) && owner.describe(query, capturedPrivateRows.get(key))
        : prepared
          ? owner.describe(query, prepared.row, prepared.repository.current() ?? null)
          : owner.describe(query);
      if (
        prepared &&
        (!records.isCurrentGeneration(prepared.row, row) ||
          row?.entry?.repositoryWorkspaceId !== prepared.workspaceId)
      ) {
        throw new Error("Session repository binding changed while preparing its description");
      }
      privateRows.set(key, row);
    }
  }
  for (const row of privateRows.values()) {
    for (const group of row?.materialized.row.swarm?.groups ?? []) {
      for (const child of group.children ?? []) {
        if (!childSelections.has(child.sessionKey)) {
          const related = row?.preparedPrivate;
          const prepared = related?.relatedRows[child.sessionKey];
          childSelections.set(
            child.sessionKey,
            prepared
              ? [{ ...records.create(prepared, prepared.entry), entry: prepared.entry }]
              : related
                ? []
                : owner.selectEntries({ key: child.sessionKey }),
          );
        }
      }
    }
    if (row && !owner.isCurrent(row)) {
      throw new Error("Session changed while preparing its description; retry the request");
    }
  }
  // Targeted materialization may refresh the owner's metadata context. Capture its final facts.
  const preparedState = owner.state;
  const physicalPaths = owner.physicalPaths;
  state = {
    cfg: preparedState.cfg,
    policyConfig: preparedState.policyConfig,
    rowContext: preparedState.rowContext,
  };
  let active = true;
  const assertActive = () => {
    if (!active || !isActive()) {
      throw new Error("Session row read view is no longer active");
    }
  };
  const read: SessionRowReadView = {
    readChildVisibility(...args) {
      assertActive();
      return owner.readChildVisibility(...args);
    },
    readChildActivity(...args) {
      assertActive();
      return owner.readChildActivity(...args);
    },
    readSource(row) {
      assertActive();
      return owner.readSource(row);
    },
    describe(query, captured) {
      assertActive();
      const key = privateKey(query);
      if (!key) {
        return owner.describe(query, captured);
      }
      if (!privateRows.has(key)) {
        throw new Error("Incognito session description was not prepared");
      }
      const row = privateRows.get(key);
      return captured && !records.isCurrentGeneration(captured, row) ? undefined : row;
    },
    readMembership(query) {
      assertActive();
      const key = privateKey(query);
      if (key) {
        if (!privateRows.has(key)) {
          throw new Error("Incognito session description was not prepared");
        }
        return privateRows.get(key)?.membership;
      }
      return owner.readMembership(query);
    },
    present(record, options) {
      assertActive();
      return owner.present(record, options);
    },
    selectEntries(query) {
      assertActive();
      if (privateRows.size > 0) {
        const rows = childSelections.get(query.key);
        if (!rows) {
          throw new Error("Session child selection was not prepared");
        }
        return rows;
      }
      return owner.selectEntries(query);
    },
    get physicalPaths() {
      assertActive();
      return physicalPaths;
    },
    get state() {
      assertActive();
      const policyConfig = owner.getPolicyConfig();
      if (state.policyConfig !== policyConfig) {
        state = { ...state, policyConfig };
      }
      return state;
    },
  };
  try {
    const result = consume(read);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Session row read consumers must remain synchronous");
    }
    assertActive();
    for (const row of privateRows.values()) {
      row?.privateSource?.assertCurrent();
    }
    return result;
  } finally {
    active = false;
    privateRows.clear();
    childSelections.clear();
  }
}

/** Consume prepared facts with the request's cancellation scope. */
export async function withReadySessionRows<T>(
  owner: {
    withPreparedExactRows<U>(
      queries: (config: OpenClawConfig) => readonly records.Lookup[],
      consume: (read: SessionRowReadView) => U,
      options?: SessionRowPreparationOptions,
    ): Promise<U>;
  },
  queries: (config: OpenClawConfig) => readonly records.Lookup[],
  consume: (read: SessionRowReadView) => T,
  options?: SessionRowPreparationOptions,
): Promise<T> {
  const signal = getAsyncWorkSignal();
  const select = (config: OpenClawConfig) => {
    signal?.throwIfAborted();
    return queries(config);
  };
  const consumeCurrent = (read: SessionRowReadView) => {
    signal?.throwIfAborted();
    return consume(read);
  };
  signal?.throwIfAborted();
  const result = await owner.withPreparedExactRows(select, consumeCurrent, options);
  signal?.throwIfAborted();
  return result;
}

// Child summaries share the same membership boundary as top-level rows.
export function prepareLinkedSessionEntryFilter(
  projection: SessionRowReadView,
  filter:
    | ((key: string, entry: SessionSharingTarget["entry"], isMember?: boolean) => boolean)
    | undefined,
  profileId: string | undefined,
) {
  return (
    key: string,
    entry: SessionSharingTarget["entry"],
    agentId?: string,
    storePath?: string,
  ) =>
    filter?.(
      key,
      entry,
      Boolean(
        profileId &&
        agentId &&
        projection.readMembership({ key, agentId, storePath })?.has(profileId),
      ),
    ) !== false;
}
