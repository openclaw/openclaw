import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { withCanonicalSessionValidationDeferral } from "../config/sessions/session-canonical-validation-deferral.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { PreparedRepositoryWorkspace } from "../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import * as records from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";

export type SessionRowPreparationOptions = {
  includeAncestors?: boolean;
  selection?: boolean;
};

/** Synchronous selection reenters through the existing exact worker preparation owner. */
export class SessionRowFactsPending extends Error {
  constructor(readonly queries: readonly records.Lookup[]) {
    super("Session row facts require worker reconciliation");
  }
}

export type SessionRowReadView = {
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
  readonly state: {
    cfg: OpenClawConfig;
    policyConfig: OpenClawConfig;
    rowContext: SessionListRowContext;
  };
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

export async function withPreparedSessionRows<T>(
  owner: SessionRowReadView & {
    isCurrent(row: records.Row): boolean;
    getPolicyConfig(): OpenClawConfig;
  },
  isActive: () => boolean,
  queries: (config: OpenClawConfig) => readonly records.Lookup[],
  consume: (read: SessionRowReadView) => T,
  privateRepositories?: ReadonlyMap<string, PreparedPrivateSessionRepository>,
) {
  if (!isActive()) {
    throw new Error("Session row read view is no longer active");
  }
  return withCanonicalSessionValidationDeferral(() => {
    const state = owner.state;
    return consumePreparedSessionRows(
      owner,
      isActive,
      queries(state.cfg),
      consume,
      state,
      privateRepositories,
    );
  });
}

/** Reenter the same synchronous consumer after canonical readiness finishes. */
export async function withReadySessionRows<T>(
  owner: {
    withPreparedExactRows<U>(
      queries: (config: OpenClawConfig) => readonly records.Lookup[],
      consume: (read: SessionRowReadView) => U,
      options?: SessionRowPreparationOptions,
    ): ReturnType<typeof withPreparedSessionRows<U>>;
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
  while (true) {
    signal?.throwIfAborted();
    const prepared = await owner.withPreparedExactRows(select, consumeCurrent, options);
    signal?.throwIfAborted();
    if (prepared.kind === "complete") {
      return prepared.value;
    }
    const { certifySessionCanonicalValidationPending } =
      await import("../config/sessions/session-canonical-validation-readiness.js");
    signal?.throwIfAborted();
    await certifySessionCanonicalValidationPending(prepared.database);
  }
}

/** Private rows belong only to this synchronous consumer, never to the resident roster. */
function consumePreparedSessionRows<T>(
  owner: SessionRowReadView & {
    isCurrent(row: records.Row): boolean;
    getPolicyConfig(): OpenClawConfig;
  },
  isActive: () => boolean,
  queries: readonly records.Lookup[],
  consume: (read: SessionRowReadView) => T,
  initialState: SessionRowReadView["state"],
  privateRepositories: ReadonlyMap<string, PreparedPrivateSessionRepository> | undefined,
): T {
  let state = initialState;
  const privateRows = new Map<string, records.MaterializedRow | undefined>();
  const childSelections = new Map<string, records.EntryRow[]>();
  const privateKey = (query: records.Lookup) => privateSessionRowReadKey(state.cfg, query);
  for (const query of queries) {
    const key = privateKey(query);
    if (key && !privateRows.has(key)) {
      const prepared = privateRepositories?.get(key);
      const row = prepared
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
          childSelections.set(child.sessionKey, owner.selectEntries({ key: child.sessionKey }));
        }
      }
    }
    // Native custody and deletion admission remain authoritative until the memory owner moves.
    if (row && !owner.isCurrent(row)) {
      throw new Error("Session changed while preparing its description; retry the request");
    }
  }
  // Targeted materialization may refresh the owner's metadata context. Capture its final facts.
  const preparedState = owner.state;
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
    get state() {
      assertActive();
      return { ...state, policyConfig: owner.getPolicyConfig() };
    },
  };
  try {
    const result = consume(read);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Session row read consumers must remain synchronous");
    }
    return result;
  } finally {
    active = false;
    privateRows.clear();
    childSelections.clear();
  }
}
