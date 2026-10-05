import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveSharedAuthStoreOwnershipAsync } from "../agents/auth-profiles/path-resolve.js";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { resolveStateDir } from "../config/paths.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { findSessionRepositoryWorkspaces } from "../state/session-repository-workspaces.js";
import {
  createIncognitoSessionRow,
  type Row,
  type PreparedSessionRowDatabaseFacts,
} from "./session-row-projection-record.js";
import { withGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";

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
      const assertCurrent = () => {
        authority.assertCurrent();
        if (!active) {
          throw new Error("Incognito row consumer is no longer active");
        }
        for (const assert of assertions) {
          assert();
        }
        actor.assertReadable();
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
                  authority: { assertCurrent },
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
