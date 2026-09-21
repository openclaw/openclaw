import { expectDefined } from "@openclaw/normalization-core";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-gateway.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  create as createSessionRow,
  sort as sortSessionRows,
} from "./session-row-projection-record.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import {
  materializeSessionRow,
  presentSessionRow,
  readSessionRowInputs,
} from "./session-utils-row.js";

type Row = NonNullable<ReturnType<SessionRowProjection["describe"]>>;

/** Synthetic owner state; tests publish changes explicitly through setEntry. */
export function createSessionRowProjectionFixture(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  storePath?: string;
  agentId?: string;
  modelCatalog?: Parameters<typeof readSessionRowInputs>[0]["modelCatalog"];
  targetsBySessionKey?: GatewayStoredSessionTargets;
  rowContext?: SessionListRowContext;
}) {
  const { cfg, modelCatalog } = params;
  const storePath = params.storePath ?? "";
  const rowContext = params.rowContext ?? buildSessionListRowMetadataContext({ now: Date.now() });
  const rows = new Map<string, Row>();
  const store = { ...params.store };
  let revision = 0;
  const id = (row: Pick<Row, "agentId" | "key" | "storeTarget">) =>
    `${row.agentId}\0${row.storeTarget.storePath}\0${row.key}`;
  const describe: SessionRowProjection["describe"] = (
    { agentId, key, storePath: path },
    captured,
  ) => {
    if (captured && rows.get(id(captured))?.generation !== captured.generation) {
      return undefined;
    }
    const canonical = resolveStoredSessionKeyForAgentStore({ cfg, agentId, sessionKey: key });
    const exact = [...rows.values()].find(
      (row) =>
        row.agentId === agentId && row.key === key && (!path || row.storeTarget.storePath === path),
    );
    return (
      exact ??
      [...rows.values()].find(
        (row) =>
          row.agentId === agentId &&
          row.key === canonical &&
          (!path || row.storeTarget.storePath === path),
      )
    );
  };
  function setEntry(key: string, entry: SessionEntry | undefined) {
    const target = params.targetsBySessionKey?.get(key);
    const agentId =
      target?.agentId ??
      parseAgentSessionKey(key)?.agentId ??
      params.agentId ??
      expectDefined(listAgentIds(cfg)[0], "fixture session owner");
    const storeTarget = target?.storeTarget ?? { agentId, storePath };
    const fields = { key: target?.storeKey ?? key, agentId, storeTarget };
    const previous = rows.get(id(fields));
    delete store[key];
    revision++;
    if (!entry || entry.incognito || isIncognitoSessionKey(key)) {
      rows.delete(id(fields));
      return;
    }
    store[key] = entry;
    const { inputs, presentation } = readSessionRowInputs({
      cfg,
      storePath,
      store,
      key: fields.key,
      entry,
      agentId,
      modelCatalog,
      rowContext,
      includeDerivedTitles: true,
      includeLastMessage: true,
      skipTranscriptUsageFallback: true,
      modelSource: { entry, readSourceEntry: (parentKey) => store[parentKey] },
    });
    rows.set(id(fields), {
      ...createSessionRow(fields, entry),
      entry,
      storedEntry: entry,
      materialized: materializeSessionRow(inputs),
      materializedSequence: revision,
      fallbackModel: presentation.activeModel,
      membership: new Set(),
      parents: new Set(
        [entry.spawnedBy, entry.parentSessionKey].filter((parentKey): parentKey is string =>
          Boolean(parentKey),
        ),
      ),
      generation:
        previous &&
        previous.entry.sessionId === entry.sessionId &&
        previous.entry.lifecycleRevision === entry.lifecycleRevision
          ? previous.generation
          : Symbol("fixture-row"),
    });
  }
  for (const [key, entry] of Object.entries(store)) {
    setEntry(key, entry);
  }
  const selectEntries = (options?: Parameters<SessionRowProjection["selectEntries"]>[0]) => {
    const query = options ?? {};
    const matchingKeys =
      query.sessionIdOrKey &&
      new Set(
        [...rows.values()]
          .filter(
            (row) =>
              row.key === query.sessionIdOrKey || row.entry.sessionId === query.sessionIdOrKey,
          )
          .map((row) => row.key),
      );
    const selected = [...rows.values()].filter(
      (row) =>
        (!query.agentId || row.agentId === query.agentId) &&
        (!query.storePath || row.storeTarget.storePath === query.storePath) &&
        (!query.key || row.key === query.key) &&
        (!matchingKeys || matchingKeys.has(row.key)) &&
        (!query.parentSessionKey || row.parents.has(query.parentSessionKey)),
    );
    return sortSessionRows(selected, query.sortBy);
  };
  const projection: SessionRowProjection = {
    capture: describe,
    findBySessionId: (query) =>
      [...rows.values()].filter(
        (row) =>
          row.entry.sessionId === query.sessionId &&
          (!query.agentId ||
            row.agentId === query.agentId ||
            row.storeTarget.agentId === query.agentId) &&
          (!query.storePath || row.storeTarget.storePath === query.storePath),
      ),
    describe,
    // This row-only fixture cannot certify the resident owner's complete ancestry graph.
    ancestorRows: () => undefined,
    setArchivePageSize: () => {},
    modelFacts: (row) => {
      const source = describe(row)!.materialized.source;
      return { ...source, catalogEntry: source.thinkingProjection.catalogEntry };
    },
    withPreparedExactRows: async (queries, consume) => {
      queries(cfg);
      return { kind: "complete", value: consume(projection) };
    },
    present: (record, options) => {
      const now = options?.now ?? Date.now();
      const row = presentSessionRow(record.materialized, {
        now,
        subagentRuns: options?.subagentRuns ?? rowContext.subagentRuns.atTime(now),
        activeModel: record.fallbackModel,
        excludedChildKeys: options?.excludedChildKeys,
      });
      Object.assign(row, record.facts?.present());
      if (!options?.includeDerivedTitles) {
        delete row.derivedTitle;
      }
      if (!options?.includeLastMessage) {
        delete row.lastMessagePreview;
      }
      return row;
    },
    ensureMaterialized: () => Promise.resolve(),
    get materializedCount() {
      return revision;
    },
    dirtyRowCount: 0,
    needsMaterialization: false,
    state: {
      get revision() {
        return revision;
      },
      cfg,
      modelCatalog,
      rowContext,
      scope: (options) => ({
        paths: new Map([...rows.values()].map((row, index) => [row.storeTarget.storePath, index])),
        path: storePath,
        agentId: options.agentId ? normalizeAgentId(options.agentId) : undefined,
        configuredAgentIds: options.configuredAgentsOnly ? new Set(listAgentIds(cfg)) : undefined,
      }),
    },
    isCurrent: (row) => rows.get(id(row))?.generation === row.generation,
    selectEntries,
    listCreatedActors: () =>
      selectEntries({ sortBy: null }).flatMap((row) =>
        row.entry.createdActor ? [row.entry.createdActor] : [],
      ),
    snapshot: (query, options) => {
      const record = describe(query);
      return record
        ? { row: projection.present(record, options), lifecycleRunId: record.entry.lifecycleRunId }
        : { row: null };
    },
    dispose: () => {
      revision++;
      rows.clear();
    },
  };
  return Object.assign(projection, { setEntry });
}

/** One actual owner per isolated state scope, retained across warm reads and writes. */
export function createResidentSessionRowReader() {
  let pending: Promise<SessionRowProjection> | undefined;
  const ready = () =>
    (pending ??= createSessionRowProjection({
      cfg: getRuntimeConfig(),
      getConfig: getRuntimeConfig,
    }));
  const snapshot = async (
    key: string,
    options: Parameters<SessionRowProjection["snapshot"]>[1] & { agentId?: string } = {},
  ) => {
    const projection = await ready();
    await projection.ensureMaterialized();
    const owner = resolveRequestedSessionAgentId(projection.state.cfg, key, options.agentId);
    if (!owner.ok) {
      throw new Error(owner.error.message);
    }
    return projection.snapshot({ key, agentId: owner.agentId }, options);
  };
  return {
    ready,
    snapshot,
    row: async (...args: Parameters<typeof snapshot>) => (await snapshot(...args)).row,
    async dispose() {
      if (pending) {
        (await pending).dispose();
      }
      pending = undefined;
    },
  };
}
