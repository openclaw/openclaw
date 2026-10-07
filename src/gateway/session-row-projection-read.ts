import { expectDefined } from "@openclaw/normalization-core";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import { rowToAcpSessionMeta } from "../acp/runtime/session-meta-readonly.js";
import { resolveSharedAuthStoreOwnershipAsync } from "../agents/auth-profiles/path-resolve.js";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { resolveStateDir } from "../config/paths.js";
import { captureCanonicalSessionReaderContinuation } from "../config/sessions/session-canonical-key.js";
import { captureSessionEntryNativeMutationWitness } from "../config/sessions/session-entry-read-ordered.js";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import { projectionLane } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  prepareSessionRowPublicationScope,
  sessionChangeAffectsStoredRow,
} from "../sessions/session-row-facts.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { findSessionRepositoryWorkspaces } from "../state/session-repository-workspaces.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import {
  createIncognitoSessionRow,
  identity,
  isCurrentGeneration,
  isPreparedSessionRowDatabaseFacts,
  type RetainedSessionRowDatabaseFacts,
  type PreparedSessionRowDatabaseFacts,
  type Row,
} from "./session-row-projection-record.js";
import { withGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";

/** Retain each selected store until its prepared facts have entered the resident row owner. */
export async function withSessionRowDatabaseFacts(
  owner: {
    rows: ReadonlyMap<string, Row>;
    dirty: ReadonlySet<string>;
    revision: () => number | undefined;
    prepareRegistryFacts: () => Promise<void> | undefined;
    env: NodeJS.ProcessEnv;
    cfg: OpenClawConfig;
    selected?: ReadonlySet<string>;
  },
  consume: {
    refreshPending: (ids: readonly string[]) => boolean;
    accept: (
      ids: readonly string[],
      facts: ReadonlyMap<string, PreparedSessionRowDatabaseFacts>,
    ) => void;
  },
): Promise<void> {
  const revision = owner.revision();
  const ids: string[] = [];
  for (const id of owner.selected ?? owner.dirty) {
    ids.push(id);
    if (ids.length === MAX_SESSION_ROW_FACTS_KEYS) {
      break;
    }
  }
  // New dirty keys append after this batch; finish its accepted rows before another read.
  if (consume.refreshPending(ids)) {
    return;
  }
  const retained = new Map<string, PreparedSessionRowDatabaseFacts>();
  for (const id of ids) {
    const facts = owner.rows.get(id)?.retainedDatabaseFacts;
    if (facts && isPreparedSessionRowDatabaseFacts(facts)) {
      retained.set(id, facts);
    }
  }
  if (retained.size > 0) {
    // Related-row changes retain stored facts but still need current lineage.
    consume.accept([...retained.keys()], retained);
    return;
  }
  const rows = ids.flatMap((id) => owner.rows.get(id) ?? []);
  const rowRevisions = new Map(rows.map((row) => [identity(row), row.databaseFactsRevision]));
  const env = owner.env;
  const shared = captureOpenClawStateReadWorkerContext({
    env,
    path: resolveOpenClawStateSqlitePath(env),
  });
  const groups = new Map<
    string,
    {
      database: { agentId: string; path: string; env: NodeJS.ProcessEnv };
      candidate: ReturnType<typeof captureSessionStoreReadCandidate>;
      rows: Row[];
    }
  >();
  for (const row of rows) {
    const agentId = normalizeAgentId(row.storeTarget.agentId);
    const pathname = resolveOpenClawAgentSqlitePath({
      agentId,
      path: row.storeTarget.storePath,
      env,
    });
    const key = JSON.stringify([agentId, pathname]);
    let group = groups.get(key);
    if (!group) {
      const candidate = captureSessionStoreReadCandidate(pathname);
      group = {
        database: { agentId, path: candidate.physicalPath, env },
        candidate,
        rows: [],
      };
      groups.set(key, group);
    }
    if (!row.retainedDatabaseFacts) {
      group.rows.push(row);
    }
  }
  const selected = [...groups.values()];
  const readGroups = selected.filter((group) => group.rows.length > 0);
  const native = retainOpenClawAgentDatabaseReadCandidates(
    selected.flatMap(({ candidate }) => [
      candidate,
      { ...candidate, path: candidate.physicalPath },
    ]),
    env,
  );
  const continuations: Array<{
    agentId: string;
    path: string;
    owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
  }> = [];
  const assertCurrent = () => {
    for (const { candidate } of selected) {
      assertSessionStoreReadCandidate(candidate.path, [candidate]);
    }
    for (const continuation of continuations) {
      continuation.owner.assertCurrent();
    }
  };
  try {
    for (const database of native.databases) {
      const continuation = captureCanonicalSessionReaderContinuation(database);
      if (continuation) {
        continuations.push({
          agentId: database.agentId,
          path: captureSessionStoreReadCandidate(database.path).physicalPath,
          owner: continuation,
        });
      }
    }
    assertCurrent();
    await withSessionHistoryWorkerDatabases(
      readGroups.map(({ database }) => database),
      async (owners) => {
        const facts = new Map<string, RetainedSessionRowDatabaseFacts>(
          rows.flatMap((row) =>
            row.retainedDatabaseFacts ? [[identity(row), { ...row.retainedDatabaseFacts }]] : [],
          ),
        );
        // Finish each accepted read before releasing any captured database owner on failure.
        for (const [index, group] of readGroups.entries()) {
          const databaseOwner = expectDefined(owners[index], "captured session row database");
          const continuation = continuations.find(
            (item) => item.agentId === group.database.agentId && item.path === group.database.path,
          )?.owner;
          const reply = await databaseOwner.readRowFacts({
            env,
            sessionKeys: [...new Set(group.rows.map((row) => row.key))],
            continuation: continuation?.receipt,
          });
          continuation?.assertCurrent();
          const byKey = new Map(reply.rows.map((row) => [row.sessionKey, row]));
          for (const row of group.rows) {
            const prepared = byKey.get(row.key);
            if (prepared) {
              facts.set(identity(row), { ...prepared });
            }
          }
        }
        const sharedRows = rows.flatMap((row) => {
          const prepared = facts.get(identity(row));
          if (!prepared) {
            return [];
          }
          if (!prepared.entry) {
            prepared.acpMeta = null;
          }
          if (!prepared.entry?.repositoryWorkspaceId) {
            prepared.repositoryWorkspace = null;
          }
          return isPreparedSessionRowDatabaseFacts(prepared) ? [] : [{ row, prepared }];
        });
        if (sharedRows.length) {
          const reply = await executeExistingOpenClawStateRead(
            { env, path: resolveOpenClawStateSqlitePath(env) },
            {
              type: "sessionRows.sharedFacts",
              entries: sharedRows.map(({ row, prepared }) => ({
                ...(prepared.acpMeta === undefined
                  ? {
                      acp: {
                        keys: [
                          buildAcpDatabaseSessionKey(
                            normalizeStoreSessionKey(row.key),
                            row.agentId,
                          ),
                        ],
                        entry: {
                          sessionId: prepared.entry?.sessionId,
                          lifecycleRevision: prepared.entry?.lifecycleRevision,
                          sessionStartedAt: prepared.entry?.sessionStartedAt,
                        },
                      },
                    }
                  : {}),
                ...(prepared.repositoryWorkspace === undefined &&
                prepared.entry?.repositoryWorkspaceId
                  ? {
                      repositoryWorkspace: {
                        agentId: row.agentId,
                        sessionKey: row.key,
                        workspaceId: prepared.entry.repositoryWorkspaceId,
                      },
                    }
                  : {}),
              })),
            },
            { context: shared },
          );
          if (reply && (!reply.ok || reply.type !== "sessionRows.sharedFacts")) {
            throw new Error("Unexpected session row shared-state facts");
          }
          for (const [index, { prepared }] of sharedRows.entries()) {
            const sharedFacts = reply?.rows[index];
            if (prepared.acpMeta === undefined) {
              prepared.acpMeta = sharedFacts?.acp ? rowToAcpSessionMeta(sharedFacts.acp) : null;
            }
            if (prepared.repositoryWorkspace === undefined) {
              prepared.repositoryWorkspace = sharedFacts?.repositoryWorkspace ?? null;
            }
          }
        }
        const preparedFacts = new Map<string, PreparedSessionRowDatabaseFacts>();
        for (const [id, row] of facts) {
          if (isPreparedSessionRowDatabaseFacts(row)) {
            preparedFacts.set(id, row);
          }
        }
        // Registry renewal changes presentation, not the captured SQLite facts.
        // Prepare the current lineage before accepting those facts instead of reading them again.
        for (
          let pending = owner.prepareRegistryFacts();
          pending;
          pending = owner.prepareRegistryFacts()
        ) {
          await pending;
        }
        for (const databaseOwner of owners) {
          databaseOwner.assertCurrent();
        }
        if (sharedRows.length) {
          shared.admission.assertCurrent();
        }
        assertCurrent();
        if (revision !== undefined && owner.revision() === revision) {
          const currentIds = rows
            .filter(
              (row) =>
                (owner.dirty.has(identity(row)) ||
                  (owner.selected?.has(identity(row)) &&
                    isColdArchivedSessionRow(owner.rows.get(identity(row)) ?? row))) &&
                isCurrentGeneration(row, owner.rows.get(identity(row))) &&
                owner.rows.get(identity(row))?.databaseFactsRevision ===
                  rowRevisions.get(identity(row)),
            )
            .map(identity);
          consume.accept(currentIds, preparedFacts);
          assertCurrent();
        }
      },
      projectionLane,
    );
  } finally {
    for (const continuation of continuations.toReversed()) {
      continuation.owner.release();
    }
    native.release();
  }
}

type IncognitoRowResources = {
  assertions: Array<() => void>;
  acp: Array<Awaited<ReturnType<IncognitoAgentDatabaseExecution["acp"]["prepareEntryRead"]>>>;
  releases: Array<() => void>;
};

async function withRetainedIncognitoSessionRow<T>(
  params: {
    actor: IncognitoSessionActor;
    prepareAcp: IncognitoAgentDatabaseExecution["acp"]["prepareEntryRead"];
    authority: IncognitoSessionAuthority;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    key: string;
  },
  consume: (prepared: {
    present: () => Row | undefined;
    durable: Array<{ key: string; agentId: string; preserveQualifiedAddress: boolean }>;
    relatedRows: NonNullable<Row["preparedPrivate"]>["relatedRows"];
    assertCurrent: () => void;
  }) => Promise<T>,
  retained: IncognitoRowResources,
): Promise<T> {
  const { actor, authority, cfg, key } = params;
  const env = { ...params.env, OPENCLAW_STATE_DIR: resolveStateDir(params.env) };
  if (
    !isIncognitoSessionKey(key) ||
    parseAgentSessionKey(key)?.agentId !== actor.agentId ||
    actor.path !== resolveIncognitoOpenClawAgentSqlitePath({ agentId: actor.agentId, env })
  ) {
    throw new Error("Incognito row belongs to another session or physical store");
  }
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  const shared = captureOpenClawStateReadWorkerContext({ env, path: sharedPath });
  actor.assertCurrent();
  authority.assertCurrent();
  return actor.sessions
    .withSharedState(async () => {
      await resolveSharedAuthStoreOwnershipAsync(shared);
      actor.assertCurrent();
      authority.assertCurrent();
      const { value, snapshot } = await actor.sessions.readRow(authority, key);
      retained.assertions.push(() => {
        authority.assertCurrent();
        actor.assertReadable();
        snapshot.assertCurrent();
      });
      let active = true;
      const assertions = [snapshot.assertCurrent];
      const assertSourcesCurrent = (checks: readonly (() => void)[]) => {
        authority.assertCurrent();
        for (const assert of checks) {
          assert();
        }
        actor.assertReadable();
      };
      const assertCurrent = () => {
        if (!active) {
          throw new Error("Incognito row consumer is no longer active");
        }
        assertSourcesCurrent(assertions);
      };
      if (!value) {
        try {
          return await consume({
            present: () => undefined,
            durable: [],
            relatedRows: {},
            assertCurrent,
          });
        } finally {
          active = false;
        }
      }
      const claim = actor.sessions.captureCurrent(key);
      assertions.push(() => claim.authorize(authority, "commit"));
      const acp = await params.prepareAcp({
        authority,
        cfg,
        env,
        databasePath: sharedPath,
        sessionKey: key,
      });
      retained.acp.push(acp);
      try {
        assertions.push(acp.assertCurrent);
        assertCurrent();
        const facts: PreparedSessionRowDatabaseFacts = {
          ...value.row,
          acpMeta: acp.session?.acp ?? null,
          repositoryWorkspace: null,
        };
        if (facts.entry.repositoryWorkspaceId) {
          const workspaces = await findSessionRepositoryWorkspaces(
            [{ agentId: actor.agentId, sessionKey: key }],
            { env, path: sharedPath },
          );
          assertCurrent();
          facts.repositoryWorkspace =
            workspaces.find(
              (workspace) => workspace.workspaceId === facts.entry.repositoryWorkspaceId,
            ) ?? null;
        }
        const relatedRows = Object.fromEntries(
          value.children.map((child) => [
            child.sessionKey,
            {
              key: child.sessionKey,
              agentId: actor.agentId,
              storeTarget: { agentId: actor.agentId, storePath: actor.path },
              entry: child.entry,
            },
          ]),
        );
        const present = () => {
          assertCurrent();
          return createIncognitoSessionRow({
            cfg,
            key,
            agentId: actor.agentId,
            storePath: actor.path,
            entry: facts.entry,
            membership: actor.sessions.readSharing(key)?.membership,
            source: { identity: actor.identity.incarnation, assertCurrent },
            prepared: {
              relatedRows,
              databaseFacts: facts,
              titleFields: value.titleFields,
              terminalModel: value.terminalModel,
            },
          });
        };
        const parentKey = facts.entry.parentSessionKey || resolveSessionParentSessionKey(key);
        const relatedKeys = [
          ...new Set([
            ...(parentKey ? [parentKey] : []),
            ...listSubagentSessionListRunsForControllers([key]).map((run) => run.childSessionKey),
          ]),
        ].filter((relatedKey) => relatedKey !== key && !relatedRows[relatedKey]);
        const privateKeys = relatedKeys.filter(isIncognitoSessionKey);
        const durable = relatedKeys
          .filter((relatedKey) => !isIncognitoSessionKey(relatedKey))
          .map((relatedKey) => ({
            key: relatedKey,
            agentId: parseAgentSessionKey(relatedKey)?.agentId ?? actor.agentId,
            preserveQualifiedAddress: true,
          }));
        if (parentKey && durable.some((selection) => selection.key === parentKey)) {
          // Prepare the shipped alias fallback in the same batch; a literal parent wins.
          durable.push({
            key: parentKey,
            agentId: parseAgentSessionKey(parentKey)?.agentId ?? actor.agentId,
            preserveQualifiedAddress: false,
          });
        }
        const withDurable = () => consume({ present, durable, relatedRows, assertCurrent });
        // Acquisitions outlive presentation and retain root checks, never their own or siblings'.
        const acquisitionAssertions = [...assertions];
        const withPrivate = async (index: number): Promise<T> => {
          const relatedKey = privateKeys[index];
          if (!relatedKey) {
            return withDurable();
          }
          const agentId = parseAgentSessionKey(relatedKey)?.agentId ?? actor.agentId;
          const capturedActor =
            agentId === actor.agentId
              ? undefined
              : await captureOpenClawAgentDatabaseExecution({
                  kind: "ephemeral",
                  agentId,
                  env,
                  authority: { assertCurrent: () => assertSourcesCurrent(acquisitionAssertions) },
                  existingOnly: true,
                });
          const relatedActor = agentId === actor.agentId ? actor : capturedActor;
          assertCurrent();
          if (!relatedActor) {
            return withPrivate(index + 1);
          }
          try {
            return await relatedActor.sessions.withSharedState(async () => {
              const prepared = await relatedActor.sessions.read(
                { assertCurrent },
                { sessionKey: relatedKey },
              );
              assertions.push(() => relatedActor.assertReadable(), prepared.snapshot.assertCurrent);
              retained.assertions.push(prepared.snapshot.assertSettledCurrent);
              if (prepared.entry) {
                relatedRows[relatedKey] = {
                  key: relatedKey,
                  agentId: relatedActor.agentId,
                  storeTarget: { agentId: relatedActor.agentId, storePath: relatedActor.path },
                  entry: prepared.entry,
                };
              }
              return withPrivate(index + 1);
            });
          } finally {
            await capturedActor?.release();
          }
        };
        return await withPrivate(0);
      } finally {
        active = false;
      }
    })
    .then((result) => {
      authority.assertCurrent();
      actor.assertReadable();
      return result;
    });
}

type IncognitoRowParams = Parameters<typeof withRetainedIncognitoSessionRow>[0];

function withIncognitoSessionRows<T>(
  selections: readonly IncognitoRowParams[],
  consume: (rows: ReadonlyMap<string, Row | undefined>) => T,
): Promise<T> {
  const prepared: Array<Parameters<Parameters<typeof withRetainedIncognitoSessionRow>[1]>[0]> = [];
  const resources: IncognitoRowResources = { assertions: [], acp: [], releases: [] };
  const finish = () => {
    for (const row of prepared) {
      row.assertCurrent();
    }
    const rows = new Map(
      selections.map((selection, index) => [
        JSON.stringify([selection.actor.agentId, selection.key]),
        prepared[index]!.present(),
      ]),
    );
    const result = consume(rows);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw new Error("Incognito row consumers must remain synchronous");
    }
    for (const row of prepared) {
      row.assertCurrent();
    }
    return result;
  };
  const retain = (index: number): Promise<T> => {
    const selection = selections[index];
    if (selection) {
      return withRetainedIncognitoSessionRow(
        selection,
        async (row) => {
          prepared.push(row);
          try {
            return await retain(index + 1);
          } finally {
            prepared.pop();
          }
        },
        resources,
      );
    }
    const durable = prepared.flatMap((row) => row.durable.map((target) => ({ row, target })));
    const [first, ...rest] = durable;
    if (!first) {
      return Promise.resolve(finish());
    }
    return withGatewaySessionStoreTarget(
      {
        cfg: selections[0]!.cfg,
        env: selections[0]!.env,
        ...first.target,
        relatedKeys: rest.map(({ target }) => target),
        projection: "list",
        ordered: true,
      },
      (target, _membership, assertCurrent, relatedTargets) => {
        assertCurrent();
        const sources = [target, ...relatedTargets].flatMap((selected) =>
          (selected.capturedReadSources ?? []).map((source) => ({
            source,
            scope: prepareSessionRowPublicationScope([source.path], source.databaseIdentity),
            sessionKeys: selected.storeKeys,
          })),
        );
        const assertNativeCurrent = captureSessionEntryNativeMutationWitness(
          sources.map(({ source }) => ({ ...source, env: selections[0]!.env })),
        );
        let changed = false;
        resources.releases.push(
          sessionChanges.subscribeFacts((change) => {
            changed ||= sources.some(({ source, scope, sessionKeys }) =>
              sessionChangeAffectsStoredRow(change, {
                ...scope,
                agentId: source.agentId,
                sessionKeys,
              }),
            );
          }),
        );
        resources.assertions.push(() => {
          assertNativeCurrent();
          if (changed) {
            throw new Error("Session entry changed during read");
          }
          for (const { source } of sources) {
            if (typeof source.databaseIdentity !== "string") {
              throw new Error("Related durable session requires its captured file identity");
            }
            assertExistingDatabaseIdentity(
              source.path,
              `file:${source.databaseIdentity}`,
              source.databaseBirthtime,
            );
          }
        });
        for (const [targetIndex, selected] of [target, ...relatedTargets].entries()) {
          const { row, target: requested } = durable[targetIndex]!;
          const entry = selected.store[selected.canonicalKey];
          if (entry && !row.relatedRows[requested.key]) {
            const source = expectDefined(selected.readSource, "captured related session source");
            row.relatedRows[requested.key] = {
              key: selected.canonicalKey,
              agentId: selected.agentId,
              storeTarget: { agentId: source.agentId, storePath: source.path },
              entry,
            };
          }
        }
        const result = finish();
        assertCurrent();
        return result;
      },
    );
  };
  const release = () => {
    for (const acp of resources.acp.toReversed()) {
      acp.release();
    }
    for (const releaseResource of resources.releases.toReversed()) {
      releaseResource();
    }
  };
  return retain(0).then(
    (result) => {
      try {
        for (const assertCurrent of resources.assertions) {
          assertCurrent();
        }
        for (const acp of resources.acp) {
          acp.assertCurrent();
        }
        return result;
      } finally {
        release();
      }
    },
    (error: unknown) => {
      release();
      throw error;
    },
  );
}

/**
 * Private presentation consumes the captured row synchronously inside its retained owners.
 * @internal Knip production exception; P7 retains the single-row adapter for bound acquisition.
 */
export function withIncognitoSessionRow<T>(
  params: Omit<IncognitoRowParams, "prepareAcp" | "actor"> & {
    actor: IncognitoAgentDatabaseExecution;
  },
  consume: (row: Row | undefined) => T,
): Promise<T> {
  return withIncognitoSessionRows(
    [{ ...params, prepareAcp: (input) => params.actor.acp.prepareEntryRead(input) }],
    (rows) => consume(rows.get(JSON.stringify([params.actor.agentId, params.key]))),
  );
}

/** Retain all selected private rows through the existing synchronous presentation frame. */
export function withBoundIncognitoSessionRows<T>(
  cfg: OpenClawConfig,
  queries: readonly { key: string; agentId: string; storePath?: string }[],
  consume: (rows: ReadonlyMap<string, Row | undefined>) => T,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const env = { ...environment, OPENCLAW_STATE_DIR: resolveStateDir(environment) };
  const selections = queries.flatMap((query) => {
    const binding = captureIncognitoSessionBinding({ ...query, sessionKey: query.key, env });
    return binding
      ? [
          {
            actor: binding.actor,
            prepareAcp: async (
              params: Parameters<IncognitoAgentDatabaseExecution["acp"]["prepareEntryRead"]>[0],
            ) => {
              const { prepareIncognitoAcpSessionEntryRead } =
                await import("../acp/runtime/session-meta-worker-mutation.js");
              return prepareIncognitoAcpSessionEntryRead({
                ...params,
                actor: binding.actor,
                storePath: binding.actor.path,
              });
            },
            authority: { assertCurrent: () => binding.admissionSignal?.throwIfAborted() },
            cfg,
            env,
            key: query.key,
          },
        ]
      : [];
  });
  return withIncognitoSessionRows(selections, consume);
}
