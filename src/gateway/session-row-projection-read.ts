import { expectDefined } from "@openclaw/normalization-core";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { resolveSharedAuthStoreOwnershipAsync } from "../agents/auth-profiles/path-resolve.js";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { resolveStateDir } from "../config/paths.js";
import { captureCanonicalSessionReaderContinuation } from "../config/sessions/session-canonical-key.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import { projectionLane } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { findSessionRepositoryWorkspaces } from "../state/session-repository-workspaces.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import {
  createIncognitoSessionRow,
  identity,
  isCurrentGeneration,
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
    if (facts) {
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
    group.rows.push(row);
  }
  const selected = [...groups.values()];
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
      selected.map(({ database }) => database),
      async (owners) => {
        const facts = new Map<string, PreparedSessionRowDatabaseFacts>();
        // Finish each accepted read before releasing any captured database owner on failure.
        for (const [index, group] of selected.entries()) {
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
              facts.set(identity(row), {
                ...prepared,
                acpMeta: null,
                repositoryWorkspace: null,
              });
            }
          }
        }
        const acpRows = rows.flatMap((row) => {
          const prepared = facts.get(identity(row));
          return prepared?.entry ? [{ row, prepared, entry: prepared.entry }] : [];
        });
        const acpMetadata = acpRows.length
          ? await readAcpSessionMetaForEntries({
              env,
              cfg: owner.cfg,
              entries: acpRows.map(({ row, entry }) => ({
                agentId: row.agentId,
                sessionKey: row.key,
                entry,
              })),
            })
          : [];
        for (const [index, { prepared }] of acpRows.entries()) {
          prepared.acpMeta = acpMetadata[index] ?? null;
        }
        const repositoryRows = rows.flatMap((row) => {
          const prepared = facts.get(identity(row));
          return prepared?.entry?.repositoryWorkspaceId ? [{ row, prepared }] : [];
        });
        if (repositoryRows.length) {
          const workspaces = await findSessionRepositoryWorkspaces(
            repositoryRows.map(({ row }) => ({ agentId: row.agentId, sessionKey: row.key })),
            { path: resolveOpenClawStateSqlitePath(env), env },
          );
          const byWorkspace = new Map(
            workspaces.map((workspace) => [workspace.workspaceId, workspace]),
          );
          for (const { prepared } of repositoryRows) {
            prepared.repositoryWorkspace =
              byWorkspace.get(prepared.entry!.repositoryWorkspaceId!) ?? null;
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
          consume.accept(currentIds, facts);
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

/**
 * Inactive acquisition: the atomic cutover supplies the original actor, never a native fallback.
 * @internal Knip production exception; atomic P7 activation installs this acquisition.
 */
export function withIncognitoSessionRow<T>(
  params: {
    actor: IncognitoAgentDatabaseExecution;
    authority: IncognitoSessionAuthority;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    key: string;
  },
  consume: (row: Row | undefined) => T,
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
      const finish = (row: Row | undefined): T => {
        assertCurrent();
        try {
          const result = consume(row);
          if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => undefined);
            throw new Error("Incognito row consumers must remain synchronous");
          }
          assertCurrent();
          return result;
        } finally {
          active = false;
        }
      };
      if (!value) {
        return finish(undefined);
      }
      const claim = actor.sessions.captureCurrent(key);
      assertions.push(() => claim.authorize(authority, "commit"));
      const acp = await actor.acp.prepareEntryRead({
        authority,
        cfg,
        env,
        databasePath: sharedPath,
        sessionKey: key,
      });
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
        const relatedEntries = Object.fromEntries(
          value.children.map((child) => [child.sessionKey, child.entry]),
        );
        const present = () =>
          finish(
            createIncognitoSessionRow({
              cfg,
              key,
              agentId: actor.agentId,
              storePath: actor.path,
              entry: facts.entry,
              membership: actor.sessions.readSharing(key)?.membership,
              source: { identity: actor.identity.incarnation, assertCurrent },
              prepared: {
                relatedEntries,
                databaseFacts: facts,
                titleFields: value.titleFields,
                terminalModel: value.terminalModel,
              },
            }),
          );
        const parentKey = facts.entry.parentSessionKey || resolveSessionParentSessionKey(key);
        const relatedKeys = [
          ...new Set([
            ...(parentKey ? [parentKey] : []),
            ...listSubagentSessionListRunsForControllers([key]).map((run) => run.childSessionKey),
          ]),
        ].filter((relatedKey) => relatedKey !== key && !relatedEntries[relatedKey]);
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
        const withDurable = (): Promise<T> => {
          const [first, ...remaining] = durable;
          if (!first) {
            return Promise.resolve(present());
          }
          return withGatewaySessionStoreTarget(
            { cfg, env, ...first, relatedKeys: remaining, projection: "list", ordered: true },
            (target, _membership, assertDurableCurrent, relatedTargets) => {
              assertions.push(assertDurableCurrent);
              for (const [index, selected] of [target, ...relatedTargets].entries()) {
                const requested = durable[index]!;
                const entry = selected.store[selected.canonicalKey];
                if (entry && !relatedEntries[requested.key]) {
                  relatedEntries[requested.key] = entry;
                }
              }
              return present();
            },
          );
        };
        // Acquisitions outlive presentation and retain root checks, never their own or siblings'.
        const acquisitionAssertions = [...assertions];
        const withPrivate = async (index: number): Promise<T> => {
          const relatedKey = privateKeys[index];
          if (!relatedKey) {
            return withDurable();
          }
          const agentId = parseAgentSessionKey(relatedKey)?.agentId ?? actor.agentId;
          const relatedActor =
            agentId === actor.agentId
              ? actor
              : await captureOpenClawAgentDatabaseExecution({
                  kind: "ephemeral",
                  agentId,
                  env,
                  authority: { assertCurrent: () => assertSourcesCurrent(acquisitionAssertions) },
                  existingOnly: true,
                });
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
              if (prepared.entry) {
                relatedEntries[relatedKey] = prepared.entry;
              }
              return withPrivate(index + 1);
            });
          } finally {
            if (relatedActor !== actor) {
              await relatedActor.release();
            }
          }
        };
        return await withPrivate(0);
      } finally {
        active = false;
        acp.release();
      }
    })
    .then((result) => {
      authority.assertCurrent();
      actor.assertReadable();
      return result;
    });
}
