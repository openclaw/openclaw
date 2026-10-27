import { expectDefined } from "@openclaw/normalization-core";
import {
  controlUiSessionSlug,
  SESSION_UUID_SUFFIX_RE,
} from "../../packages/session-url-contract/src/index.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayStoredSessionTargets } from "../config/sessions/combined-store-model-sources.js";
import {
  replaceSessionEntrySync,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import type {
  InternalSessionEntry as SessionEntry,
  SessionAcpMeta,
} from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  create as createSessionRow,
  selectionRow,
  sort as sortSessionRows,
} from "./session-row-projection-record.js";
import { createSessionRowProjectionRevisions } from "./session-row-projection-revisions.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { deriveSessionTitle } from "./session-utils-core.js";
import {
  projectGatewaySessionRunState,
  resolveGatewaySessionDisplayName,
} from "./session-utils-display.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import {
  materializeSessionRow,
  presentSessionRow,
  readSessionRowInputs,
} from "./session-utils-row.js";
import type { SessionTitleFields } from "./session-utils.types.js";

type Row = NonNullable<ReturnType<SessionRowProjection["describe"]>>;

export function seedProjectionRow(
  name: string,
  fields: Partial<SessionEntry> = {},
  agentId = "main",
  storePath?: string,
) {
  const entry = { sessionId: name, updatedAt: 1, ...fields };
  const scope = {
    agentId,
    sessionKey: name.startsWith("agent:") ? name : `agent:${agentId}:${name}`,
    sessionId: entry.sessionId,
    storePath,
  };
  replaceSessionEntrySync(scope, entry);
  return {
    scope,
    target: scope,
    query: { agentId, key: scope.sessionKey, ...(storePath === undefined ? {} : { storePath }) },
    entry,
  };
}

export function appendProjectionMessages(
  scope: Parameters<typeof persistSessionTranscriptTurn>[0],
  ...messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"][number]["message"][]
) {
  return persistSessionTranscriptTurn(scope, {
    messages: messages.map((message) => ({ message })),
    touchSessionEntry: false,
  });
}

export function acpProjectionMeta(
  backend: string,
  runtimeSessionName: string,
  lastActivityAt = 1,
  extra: Partial<SessionAcpMeta> = {},
): SessionAcpMeta {
  return {
    backend,
    agent: "main",
    runtimeSessionName,
    mode: "persistent",
    state: "idle",
    lastActivityAt,
    ...extra,
  };
}

export function withSessionRowProjectionState(
  run: (
    create: typeof createSessionRowProjection,
    state: OpenClawTestState,
    cleanup: AsyncDisposableStack,
  ) => Promise<void>,
  foreground = false,
  options: Parameters<typeof withOpenClawTestState>[0] = { scenario: "minimal" },
) {
  return withOpenClawTestState(options, async (state) => {
    await using cleanup = new AsyncDisposableStack();
    if (foreground) {
      cleanup.defer(retainSessionListForegroundWork());
    }
    await run(
      async (params) => {
        const projection = await createSessionRowProjection(params);
        cleanup.defer(() => projection.dispose());
        return projection;
      },
      state,
      cleanup,
    );
  });
}

export function requestSessionRow(
  handler: GatewayRequestHandler,
  context: GatewayRequestHandlerOptions["context"],
  method: string,
  params: GatewayRequestHandlerOptions["params"],
  respond: GatewayRequestHandlerOptions["respond"],
  client: GatewayRequestHandlerOptions["client"] = null,
  id = method,
) {
  return handler({
    req: { type: "req", id, method },
    params,
    context,
    respond,
    client,
    isWebchatConnect: () => false,
  });
}

/** Synthetic owner state; tests publish changes explicitly through setEntry. */
export function createSessionRowProjectionFixture(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  storePath?: string;
  agentId?: string;
  modelCatalog?: Parameters<typeof readSessionRowInputs>[0]["modelCatalog"];
  targetsBySessionKey?: GatewayStoredSessionTargets;
  rowContext?: SessionListRowContext;
  titleFieldsBySessionKey?: ReadonlyMap<string, SessionTitleFields>;
}) {
  const { cfg, modelCatalog } = params;
  const storePath = params.storePath ?? "";
  const rowContext = params.rowContext ?? buildSessionListRowMetadataContext({ now: Date.now() });
  const rows = new Map<string, Row>();
  const revisions = createSessionRowProjectionRevisions(rows, new Map());
  const store = { ...params.store };
  let revision = 0;
  let revisionToken = {};
  const id = (row: Pick<Row, "agentId" | "key" | "storeTarget">) =>
    `${row.agentId}\0${row.storeTarget.storePath}\0${row.key}`;
  const matching = (query: { agentId?: string; key?: string; storePath?: string }) =>
    [...rows.values()].filter(
      (row) =>
        (!query.agentId || row.agentId === query.agentId) &&
        (!query.key || row.key === query.key) &&
        (!query.storePath || row.storeTarget.storePath === query.storePath),
    );
  const describe: SessionRowProjection["describe"] = (
    { agentId, key, storePath: path },
    captured,
  ) => {
    if (captured && rows.get(id(captured))?.generation !== captured.generation) {
      return undefined;
    }
    const canonical = resolveStoredSessionKeyForAgentStore({ cfg, agentId, sessionKey: key });
    const candidates = matching({ storePath: path }).filter((row) => row.agentId === agentId);
    return (
      candidates.find((row) => row.key === key) ?? candidates.find((row) => row.key === canonical)
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
    revisionToken = {};
    revisions.publishSelection();
    revisions.publishFacts();
    if (!entry || entry.incognito || isIncognitoSessionKey(key)) {
      rows.delete(id(fields));
      return;
    }
    store[key] = entry;
    const titleFields = params.titleFieldsBySessionKey?.get(fields.key);
    const { inputs, presentation } = readSessionRowInputs({
      cfg,
      storePath,
      store,
      key: fields.key,
      entry,
      preparedRepositoryWorkspace: null,
      agentId,
      modelCatalog,
      rowContext,
      preparedTitle: {
        derivedTitle: deriveSessionTitle(
          entry,
          titleFields?.firstUserMessage,
          resolveGatewaySessionDisplayName(fields.key, entry),
        ),
        lastMessagePreview: titleFields?.lastMessagePreview ?? undefined,
      },
      modelSource: { entry, readSourceEntry: (parentKey) => store[parentKey] },
    });
    rows.set(id(fields), {
      ...createSessionRow(fields, entry),
      entry,
      materialized: materializeSessionRow(inputs),
      materializedSequence: revision,
      fallbackModel: presentation.activeModel,
      parents: new Set(
        [
          entry.spawnedBy,
          entry.parentSessionKey,
          ...(rowContext.subagentRunsByChildSessionKey.get(fields.key) ?? []).map(
            (run) => run.controllerSessionKey || run.requesterSessionKey,
          ),
        ].filter((parentKey): parentKey is string => Boolean(parentKey)),
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
    const parentKey =
      typeof query.parentSessionKey === "string"
        ? query.parentSessionKey
        : query.parentSessionKey?.key;
    const identities =
      query.candidateSessionIdsOrKeys ??
      (query.sessionIdOrKey ? new Set([query.sessionIdOrKey]) : undefined);
    const matchingKeys =
      identities &&
      new Set(
        [...rows.values()]
          .filter((row) => identities.has(row.key) || identities.has(row.entry.sessionId))
          .map((row) => row.key),
      );
    const selected = matching(query).filter(
      (row) =>
        (!matchingKeys || matchingKeys.has(row.key)) && (!parentKey || row.parents.has(parentKey)),
    );
    return sortSessionRows(selected, query.sortBy);
  };
  const projection: SessionRowProjection = {
    findUrlCandidates(selection, agentId) {
      return matching({ agentId })
        .filter((row) => {
          const uuid = parseAgentSessionKey(row.key)?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
          return "shortId" in selection
            ? Boolean(
                uuid?.toLowerCase().replaceAll("-", "").startsWith(selection.shortId.toLowerCase()),
              )
            : row.key === selection.key ||
                Boolean(
                  uuid &&
                  selection.slug &&
                  controlUiSessionSlug(resolveGatewaySessionDisplayName(row.key, row.entry)) ===
                    selection.slug,
                );
        })
        .map((row) => ({
          agentId: row.agentId,
          key: row.key,
          storePath: row.storeTarget.storePath,
        }));
    },
    async readLookup() {
      throw new Error("Indexed lookup requires a real session row projection");
    },
    onSelectionChange: revisions.onSelectionChange,
    onFactsChange: revisions.onFactsChange,
    readTaskPublicationRevision: revisions.taskPublication,
    hasLogicalChildEntries: (parent) => selectEntries({ parentSessionKey: parent }).length > 0,
    readPreparedRowContext: () => rowContext,
    readPreparedSpawnedBy(query) {
      const row = describe(query);
      return row
        ? projectGatewaySessionRunState({ key: row.key, now: Date.now(), rowContext })
            .subagentOwner || row.storedEntry?.spawnedBy
        : undefined;
    },
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
    readPreview: () => undefined,
    readSource: () => undefined,
    readMembership: (query) => describe(query)?.membership,
    // This row-only fixture cannot certify the resident owner's complete ancestry graph.
    ancestorRows: () => undefined,
    setArchivePageSize: () => {},
    modelFacts: (query) => describe(query)!.materialized.source,
    withPreparedExactRows: async (queries, consume) => {
      queries(cfg);
      return consume(projection);
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
    prepareSelection: () => undefined,
    withSelectionPreparation: (consume) => consume(),
    needsSelectionPreparation: () => false,
    prepareMembership: () => Promise.resolve(),
    needsMembershipPreparation: () => false,
    sessionGroupTargets: () => {
      const groups = new Map<string, { agentId: string; sessionKey: string }[]>();
      for (const row of rows.values()) {
        const name = row.entry.category?.trim();
        if (name) {
          const targets = groups.get(name) ?? [];
          targets.push({ agentId: row.agentId, sessionKey: row.key });
          groups.set(name, targets);
        }
      }
      return groups;
    },
    sharingTarget(query) {
      const row = describe(query);
      return row
        ? {
            agentId: row.agentId,
            generation: row.generation,
            canonicalKey: row.key,
            entry: row.entry,
            storeKey: row.key,
            storeKeys: [row.key],
            storePath: row.storeTarget.storePath,
          }
        : null;
    },
    readCapabilityEntry(query) {
      if (query.key !== undefined) {
        const row = describe(query);
        return { entry: row?.key === query.key ? row.entry : undefined };
      }
      const candidates = [...rows.values()]
        .filter(
          (row) => row.agentId === query.agentId && row.storeTarget.storePath === query.storePath,
        )
        .toSorted((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
      const row =
        candidates.find((candidate) => candidate.entry.sessionId === query.sessionId) ??
        candidates.find((candidate) => candidate.entry.sessionId.trim() === query.sessionId);
      return { entry: row?.entry };
    },
    sharingTargetState(query) {
      const target = projection.sharingTarget(query);
      return target ? { status: "ready", target } : { status: "missing" };
    },
    hasMembership: (path, key, identity) =>
      [...rows.values()].some(
        (row) =>
          row.storeTarget.storePath === path && row.key === key && row.membership.has(identity),
      ),
    get materializedCount() {
      return revision;
    },
    dirtyRowCount: 0,
    needsMaterialization: false,
    getPolicyConfig: () => cfg,
    get sharingRevision() {
      return revisionToken;
    },
    physicalPaths: (locator) => [locator],
    state: {
      get revision() {
        return revisionToken;
      },
      cfg,
      policyConfig: cfg,
      modelCatalog,
      rowContext,
      physicalStorePaths: (path) => [path],
      scope: (options) => {
        const ownerAgentIds = new Set(listAgentIds(cfg));
        return {
          paths: new Map(
            [...rows.values()].map((row, index) => [row.storeTarget.storePath, index]),
          ),
          path: storePath,
          agentId: options.agentId ? normalizeAgentId(options.agentId) : undefined,
          configuredAgentIds: options.configuredAgentsOnly ? ownerAgentIds : undefined,
          ownerAgentIds,
        };
      },
    },
    isCurrent: (row) => rows.get(id(row))?.generation === row.generation,
    selectEntries,
    async projectRecentCandidates(profileIds) {
      const selection = createSessionRowSelection(
        cfg,
        projection.state.scope({}),
        false,
        () => rowContext,
        true,
      );
      for (const row of rows.values()) {
        selection.add(selectionRow(row)!);
      }
      return selection.createdEntries(profileIds);
    },
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
      revisionToken = {};
      rows.clear();
      revisions.dispose();
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
