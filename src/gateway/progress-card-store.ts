import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionCollaborationScope } from "../config/sessions/session-collaboration-scope.js";
import {
  captureIncognitoSessionOperation,
  captureIncognitoSessionSource,
} from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { withSessionStoreTarget } from "../config/sessions/session-store-target-runtime.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import type { ProgressCardStore } from "../session-cards/progress-card-store.types.js";
import type { ProgressCardWorkerOperations } from "../session-cards/progress-card-store.worker.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseRuntime,
} from "../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { captureGatewaySessionStoreScope } from "./board-store.js";

/**
 * The activation owner captures routing and supplies live, SQL-free authority.
 * @internal Knip production exception; atomic activation installs this store.
 */
export function createIncognitoProgressCardStore(
  resolveSession: (
    sessionKey: string,
    agentId?: string,
  ) => SessionCollaborationScope & {
    incognito: NonNullable<SessionCollaborationScope["incognito"]>;
  },
): ProgressCardStore {
  const capture = (sessionKey: string, agentId?: string, assertCurrent?: () => void) => {
    const scope = resolveSession(sessionKey, agentId);
    const target = resolveSqliteScope(scope);
    const { actor, authority } = scope.incognito;
    if (actor.agentId !== target.agentId || actor.path !== toDatabaseOptions(target).path) {
      throw new Error("Progress-card target differs from its captured incognito actor");
    }
    const claim = actor.sessions.captureCurrent(target.sessionKey);
    const expected = actor.sessions.readSharing(target.sessionKey)?.entry;
    const current: IncognitoSessionAuthority = {
      assertCurrent() {
        assertCurrent?.();
        authority.assertCurrent();
        actor.assertCurrent();
      },
      authorize(stage, facts) {
        if (
          facts.sharing?.entry?.sessionId !== expected?.sessionId ||
          facts.sharing?.entry?.lifecycleRevision !== expected?.lifecycleRevision
        ) {
          throw new Error("progress-card session changed; retry");
        }
        return authority.authorize?.(stage, facts);
      },
    };
    current.assertCurrent();
    return { actor, current, claim, sessionKey: target.sessionKey };
  };
  return {
    async get(sessionKey, agentId) {
      const target = capture(sessionKey, agentId);
      const card = await target.actor.sessions.withSharedState(() =>
        target.actor.sessions.sideData(target.current, {
          type: "session.progressCard.get",
          input: { sessionKey: target.sessionKey },
        }),
      );
      target.current.assertCurrent();
      target.claim.assertCurrent();
      target.actor.assertReadable();
      return card;
    },
    async put(sessionKey, input, agentId) {
      const target = capture(sessionKey, agentId, input.assertCurrent);
      const captured = structuredClone({
        markdown: input.markdown,
        steps: input.steps,
        expectedRevision: input.expectedRevision,
      });
      const result = await target.actor.sessions.withSharedState(() =>
        target.actor.sessions.sideData(target.current, {
          type: "session.progressCard.put",
          input: { ...captured, sessionKey: target.sessionKey },
        }),
      );
      target.current.assertCurrent();
      target.claim.assertCurrent();
      target.actor.assertReadable();
      return "card" in result ? result : { card: null };
    },
  };
}

export const progressCardStore: ProgressCardStore = {
  async get(
    sessionKey: string,
    agentId?: string,
  ): Promise<ReturnType<typeof readSessionProgressCard>> {
    const source = captureIncognitoSessionSource({ sessionKey, agentId });
    if (source && "kind" in source) {
      return null;
    }
    const incognito = captureIncognitoSessionOperation({ sessionKey, agentId });
    if (incognito) {
      return createIncognitoProgressCardStore(() => ({
        sessionKey,
        agentId: incognito.actor.agentId,
        storePath: incognito.actor.path,
        incognito,
      })).get(sessionKey, agentId);
    }
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    const scope = captureGatewaySessionStoreScope(sessionKey, agentId);
    const unsuffixed = resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath);
    if (isIncognitoOpenClawAgentSqlitePath(unsuffixed.path, { agentId: scope.agentId, env })) {
      const result = withOpenClawAgentDatabaseReadOnly(
        (database) => readSessionProgressCard(database.db, scope.sessionKey),
        { agentId: scope.agentId, path: unsuffixed.path, env },
      );
      return result.found ? result.value : null;
    }
    const target = await prepareSqliteTargetFromSessionStorePath(scope.storePath, {
      agentId: scope.agentId,
      env,
    });
    return await withSessionHistoryWorkerDatabase(
      { agentId: target.agentId ?? scope.agentId, path: target.path, env },
      (owner) => owner.readProgressCard({ sessionKey: scope.sessionKey, env }),
    );
  },
  async put(
    sessionKey: string,
    input: Parameters<typeof writeSessionProgressCard>[2] & {
      // The storage owner checks authority inside its write transaction.
      assertCurrent?: () => void;
    },
    agentId?: string,
  ): Promise<{ card: ReturnType<typeof readSessionProgressCard> }> {
    const incognito = captureIncognitoSessionOperation({ sessionKey, agentId });
    if (incognito) {
      return createIncognitoProgressCardStore(() => ({
        sessionKey,
        agentId: incognito.actor.agentId,
        storePath: incognito.actor.path,
        incognito,
      })).put(sessionKey, input, agentId);
    }
    const resolved = captureGatewaySessionStoreScope(sessionKey, agentId);
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    const capturedInput = structuredClone({
      markdown: input.markdown,
      steps: input.steps,
      expectedRevision: input.expectedRevision,
    });
    const assertCurrent = () => input.assertCurrent?.();
    assertCurrent();
    const unsuffixed = resolveUnsuffixedSqliteTargetFromSessionStorePath(resolved.storePath);
    if (isIncognitoOpenClawAgentSqlitePath(unsuffixed.path, { agentId: resolved.agentId, env })) {
      // Process-held incognito storage cannot be reopened by the durable writer.
      const databaseOptions = { agentId: resolved.agentId, path: unsuffixed.path, env };
      const result = await runOpenClawAgentWriteAdmission(
        databaseOptions,
        () =>
          withOpenClawAgentDatabaseRuntime(
            databaseOptions,
            () =>
              runOpenClawAgentWriteTransaction(
                (database) => {
                  assertCurrent();
                  return writeSessionProgressCard(database.db, resolved.sessionKey, capturedInput);
                },
                databaseOptions,
                { operationLabel: "progress-card.put" },
              ),
            assertCurrent,
          ),
        true,
      );
      return "card" in result ? result : { card: null };
    }
    const candidates = captureSessionStoreReadCandidates(resolved.storePath);
    const identities = new Map(
      candidates
        .filter((candidate) => !candidate.scope)
        .map((candidate) => {
          const identity = readDatabasePathIdentitySync(candidate.path);
          return [identity.canonicalPath, identity] as const;
        }),
    );
    const prepare = () =>
      withSessionStoreTarget(
        { ...resolved, env, candidates },
        async (target, owner) => {
          const options = { ...target.database, env };
          const identity =
            identities.get(options.path) ?? readDatabasePathIdentitySync(options.path);
          if (!identities.has(options.path) && identity.key.startsWith("file:")) {
            throw new Error("Progress-card target appeared after source capture");
          }
          const execution = captureOpenClawAgentDatabaseExecution(
            options,
            identity.key.startsWith("file:")
              ? {
                  expectedIdentity: {
                    kind: "file",
                    physicalIdentity: identity.key.slice("file:".length),
                    nativeLocation: identity.canonicalPath,
                    birthtime: identity.birthtime,
                  },
                }
              : { expectedCreationIdentity: identity },
          );
          const assertOwnerCurrent = () => {
            assertCurrent();
            owner.assertCurrent();
            execution.assertCurrent();
          };
          try {
            return await runOpenClawAgentWriteAdmission(
              options,
              async () => {
                await owner.refreshBeforeDispatch(() => execution.assertCurrent());
                await runOpenClawAgentWorkerWrite(options, () =>
                  execution.prepare({
                    assertCurrent: assertOwnerCurrent,
                    onRegistryChange: owner.onRegistryChange,
                    createAdmission(binding) {
                      return () => ({
                        nativeLocations: binding.nativeLocations,
                        admission: createSqliteWorkerOperationAdmission((request, grant) => {
                          binding.authorize(request);
                          assertOwnerCurrent();
                          if (!grant()) {
                            throw new Error("Progress-card preparation authority expired");
                          }
                        }, binding.attachment),
                      });
                    },
                  }),
                );
                await owner.revalidateTarget();
                const worker =
                  await openOpenClawAgentSqliteWorkerStore<ProgressCardWorkerOperations>(
                    options,
                    { execution },
                    {
                      moduleUrl: resolveRuntimeWorkerUrl(
                        runtimeProcessEntrypoints.progressCardStore,
                      ),
                      input: undefined,
                    },
                  );
                try {
                  const receipt = await worker.execute(
                    {
                      type: "put",
                      input: { sessionKey: resolved.sessionKey, ...capturedInput },
                    },
                    assertOwnerCurrent,
                  );
                  if (!receipt.ok) {
                    const error = new Error("Progress-card transaction failed");
                    retainOpenClawStateWorkerErrorPayload(error, receipt.error);
                    throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
                  }
                  return receipt.value;
                } finally {
                  await worker.close();
                }
              },
              true,
            );
          } finally {
            await execution.release();
          }
        },
        assertCurrent,
      );
    const result = await withSessionHistoryWorkerReadCandidates(candidates, async (custody) => {
      const persist = () => {
        custody.assertCurrent();
        return prepare();
      };
      // Exact stores reserve FIFO before discovery; logical stores must first select their file.
      return unsuffixed.agentId || unsuffixed.shared
        ? runOpenClawAgentWriteAdmission(
            { agentId: resolved.agentId, path: unsuffixed.path, env },
            persist,
            true,
          )
        : persist();
    });
    return "card" in result ? result : { card: null };
  },
};
