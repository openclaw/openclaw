import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { prepareAcpSessionEntryRead } from "../acp/runtime/session-meta-read.js";
import { readSessionRuntimeOwnershipAsync } from "../agents/harness/session-runtime-ownership.js";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { readSessionActivitySummary } from "../config/sessions/activity-summary.js";
import {
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { capturePluginStateReadDependencies } from "../plugin-state/plugin-state-publication.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { findSessionRepositoryWorkspaces } from "../state/session-repository-workspaces.js";
import { selectSessionTerminalFallbackModel } from "../status/session-fallback-model.js";
import {
  createIncognitoSessionRow,
  type PreparedSessionRowDatabaseFacts,
  type Row,
} from "./session-row-projection-record.js";
import { withGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";

/** Private rows are detached display facts; membership is read at presentation. */
export async function withMemorySessionRows<T>(
  binding: SessionActorStorageBinding,
  cfg: OpenClawConfig,
  queries: readonly { key: string; agentId: string; storePath?: string }[],
  consume: (rows: ReadonlyMap<string, Row | undefined>) => T,
  env: NodeJS.ProcessEnv,
): Promise<T> {
  let active = true;
  const releases: Array<() => void | Promise<void>> = [];
  const presentations: Array<{
    key: string;
    agentId: string;
    present: () => Row | undefined;
    relatedRows: NonNullable<Row["preparedPrivate"]>["relatedRows"];
    durable: Array<{ key: string; agentId: string; preserveQualifiedAddress: boolean }>;
  }> = [];
  try {
    for (const query of queries) {
      if (!isIncognitoSessionKey(query.key)) {
        continue;
      }
      const namespace = captureSessionActorStorageOwner({
        ...query,
        sessionKey: query.key,
        sessionActor: binding,
      })!;
      const { owner } = namespace;
      const actor =
        query.agentId === binding.agentId && query.key === binding.actor.target.sessionKey
          ? binding.actor
          : await owner?.acquireExisting(query.key, {
              assertCurrent: () => binding.actor.assertReadable(),
              assertReadable: () => binding.actor.assertReadable(),
            });
      if (!actor) {
        presentations.push({ ...query, present: () => undefined, relatedRows: {}, durable: [] });
        continue;
      }
      if (actor !== binding.actor) {
        releases.push(() => actor.release());
      }
      const selected = { ...binding, actor, agentId: namespace.agentId, path: namespace.path };
      const assertCurrent = () => {
        if (!active) {
          throw new Error("Memory row consumer is no longer active");
        }
        actor.assertReadable();
        binding.authority.assertCurrent();
      };
      await runWithSessionActorStorage(selected, async () => {
        const snapshot = actor.snapshot(binding.authority);
        if (!snapshot?.entry) {
          presentations.push({ ...query, present: () => undefined, relatedRows: {}, durable: [] });
          return;
        }
        const entry = snapshot.entry;
        const acp = await prepareAcpSessionEntryRead({
          cfg,
          env,
          sessionKey: query.key,
          agentId: selected.agentId,
          assertCurrent,
        });
        if (!acp) {
          throw new Error("Memory session row requires its selected ACP reader");
        }
        releases.push(() => acp.release());
        const runtime = await capturePluginStateReadDependencies(() =>
          readSessionRuntimeOwnershipAsync({
            config: cfg,
            agentId: selected.agentId,
            sessionKey: query.key,
            storePath: selected.path,
            sessionEntry: entry,
            readPreparedPreviousSessionId: () => entry.previousSessionId,
            assertCurrent,
          }),
        );
        releases.push(runtime.release);
        const workspaces = entry.repositoryWorkspaceId
          ? await findSessionRepositoryWorkspaces(
              [{ agentId: selected.agentId, sessionKey: query.key }],
              { env, path: resolveOpenClawStateSqlitePath(env) },
            )
          : [];
        const title = actor.storage!.readCurrent(
          { type: "session.history.title", input: { sessionId: entry.sessionId } },
          binding.authority,
        );
        const tail =
          entry.status === "done" && entry.lastRunId && entry.fallbackNotice
            ? actor.storage!.readCurrent(
                {
                  type: "session.history.bounded-tail",
                  input: {
                    sessionId: entry.sessionId,
                    options: { maxBytes: 256 * 1024, maxMessages: 1, offset: 0, readOnly: true },
                  },
                },
                binding.authority,
              )
            : undefined;
        const facts: PreparedSessionRowDatabaseFacts = {
          sessionKey: query.key,
          entry,
          hasBoard: snapshot.hasBoard,
          activitySummaryWatermark: readSessionActivitySummary(entry)
            ? snapshot.transcript.watermark
            : undefined,
          acpMeta: acp.session?.acp ?? null,
          runtimeOwnership: runtime.value ?? null,
          runtimeOwnershipDependencies: runtime.dependencies,
          repositoryWorkspace:
            workspaces.find((workspace) => workspace.workspaceId === entry.repositoryWorkspaceId) ??
            null,
        };
        const relatedRows: NonNullable<Row["preparedPrivate"]>["relatedRows"] = {};
        const relatedKeys = new Set([
          entry.parentSessionKey || resolveSessionParentSessionKey(query.key),
          ...listSubagentSessionListRunsForControllers([query.key]).map(
            (run) => run.childSessionKey,
          ),
        ]);
        for (const related of owner?.listSessions(binding.authority) ?? []) {
          if (!related.entry || related.target.sessionKey === query.key) {
            continue;
          }
          const key = related.target.sessionKey;
          if (related.entry.parentSessionKey === query.key || relatedKeys.has(key)) {
            relatedRows[key] = {
              key,
              agentId: selected.agentId,
              storeTarget: { agentId: selected.agentId, storePath: selected.path },
              entry: related.entry,
            };
          }
        }
        for (const key of relatedKeys) {
          if (!key || !isIncognitoSessionKey(key) || relatedRows[key]) {
            continue;
          }
          const relatedOwner = captureSessionActorStorageOwner({
            sessionKey: key,
            sessionActor: binding,
          })!;
          const related = relatedOwner.owner?.readSession(key, binding.authority);
          if (related?.entry) {
            relatedRows[key] = {
              key,
              agentId: relatedOwner.agentId,
              storeTarget: { agentId: relatedOwner.agentId, storePath: relatedOwner.path },
              entry: related.entry,
            };
          }
        }
        const durable = [...relatedKeys].flatMap((key) =>
          key && key !== query.key && !isIncognitoSessionKey(key) && !relatedRows[key]
            ? [
                {
                  key,
                  agentId: parseAgentSessionKey(key)?.agentId ?? selected.agentId,
                  preserveQualifiedAddress: true,
                },
              ]
            : [],
        );
        const parent = entry.parentSessionKey || resolveSessionParentSessionKey(query.key);
        const durableParent = durable.find((target) => target.key === parent);
        if (durableParent) {
          durable.push({ ...durableParent, preserveQualifiedAddress: false });
        }
        presentations.push({
          key: query.key,
          agentId: selected.agentId,
          relatedRows,
          durable,
          present() {
            acp.assertCurrent();
            runtime.assertCurrent();
            const current = actor.snapshot(binding.authority);
            if (!current?.entry) {
              return undefined;
            }
            return createIncognitoSessionRow({
              cfg,
              key: query.key,
              agentId: selected.agentId,
              storePath: selected.path,
              entry: current.entry,
              membership: new Set(current.members.map((member) => member.identityId)),
              source: { identity: snapshot.version.epoch, assertCurrent },
              prepared: {
                databaseFacts: { ...facts, entry: current.entry },
                relatedRows,
                titleFields: title.fields,
                terminalModel: selectSessionTerminalFallbackModel(entry, tail?.events[0]?.event),
              },
            });
          },
        });
      });
    }
    const finish = () => {
      const result = consume(
        new Map(
          presentations.map((row) => [JSON.stringify([row.agentId, row.key]), row.present()]),
        ),
      );
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Incognito row consumers must remain synchronous");
      }
      return result;
    };
    const durable = presentations.flatMap((row) => row.durable.map((target) => ({ row, target })));
    const [first, ...rest] = durable;
    if (!first) {
      return finish();
    }
    return await withGatewaySessionStoreTarget(
      {
        cfg,
        env,
        ...first.target,
        relatedKeys: rest.map(({ target }) => target),
        projection: "list",
        ordered: true,
      },
      (target, _membership, assertCurrent, relatedTargets) => {
        assertCurrent();
        for (const [index, selected] of [target, ...relatedTargets].entries()) {
          const { row, target: requested } = durable[index]!;
          const entry = selected.store[selected.canonicalKey];
          if (entry && !row.relatedRows[requested.key]) {
            row.relatedRows[requested.key] = {
              key: selected.canonicalKey,
              agentId: selected.agentId,
              storeTarget: { agentId: selected.agentId, storePath: selected.storePath },
              entry,
            };
          }
        }
        return finish();
      },
    );
  } finally {
    active = false;
    for (const release of releases.toReversed()) {
      await release();
    }
  }
}
