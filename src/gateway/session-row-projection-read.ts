import { expectDefined } from "@openclaw/normalization-core";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveSharedAuthStoreOwnershipAsync } from "../agents/auth-profiles/path-resolve.js";
import { readSessionRuntimeOwnershipAsync } from "../agents/harness/session-runtime-ownership.js";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { resolveStateDir } from "../config/paths.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { capturePluginStateReadDependencies } from "../plugin-state/plugin-state-publication.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { findSessionRepositoryWorkspaces } from "../state/session-repository-workspaces.js";
import { withMemorySessionRows } from "./session-row-projection-memory.js";
import {
  createIncognitoSessionRow,
  type PreparedSessionRowDatabaseFacts,
  type Row,
} from "./session-row-projection-record.js";
import { withGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";

type IncognitoRowResources = {
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
  return actor.sessions.withSharedState(async () => {
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
    if (!value) {
      try {
        return await consume({
          present: () => undefined,
          durable: [],
          relatedRows: {},
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
      const runtimeOwnership = await capturePluginStateReadDependencies(() =>
        readSessionRuntimeOwnershipAsync({
          config: cfg,
          agentId: actor.agentId,
          sessionKey: key,
          storePath: actor.path,
          sessionEntry: value.row.entry,
          readPreparedPreviousSessionId: () => value.row.entry.previousSessionId,
          assertCurrent,
        }),
      );
      retained.releases.push(runtimeOwnership.release);
      assertions.push(runtimeOwnership.assertCurrent);
      assertCurrent();
      const facts: PreparedSessionRowDatabaseFacts = {
        ...value.row,
        acpMeta: acp.session?.acp ?? null,
        runtimeOwnership: runtimeOwnership.value ?? null,
        runtimeOwnershipDependencies: runtimeOwnership.dependencies,
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
      const withDurable = () => consume({ present, durable, relatedRows });
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
  });
}

type IncognitoRowParams = Parameters<typeof withRetainedIncognitoSessionRow>[0];

function withIncognitoSessionRows<T>(
  selections: readonly IncognitoRowParams[],
  consume: (rows: ReadonlyMap<string, Row | undefined>) => T,
): Promise<T> {
  const prepared: Array<Parameters<Parameters<typeof withRetainedIncognitoSessionRow>[1]>[0]> = [];
  const resources: IncognitoRowResources = { acp: [], releases: [] };
  const finish = () => {
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
        return finish();
      },
    );
  };
  return retain(0).finally(() => {
    for (const acp of resources.acp.toReversed()) {
      acp.release();
    }
    for (const release of resources.releases.toReversed()) {
      release();
    }
  });
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
  const memory = getSessionActorStorageBinding({});
  if (memory) {
    return withMemorySessionRows(memory, cfg, queries, consume, env);
  }
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
