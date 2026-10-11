import {
  getSessionActorStorageBinding,
  withSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
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
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import type { ProgressCardStore } from "../session-cards/progress-card-store.types.js";
import type { ProgressCardWorkerOperations } from "../session-cards/progress-card-store.worker.js";
import { createSessionActorProgressCardStore } from "../session-cards/session-actor-progress-card-store.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
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

export const progressCardStore: ProgressCardStore = {
  async get(
    sessionKey: string,
    agentId?: string,
  ): Promise<ReturnType<typeof readSessionProgressCard>> {
    const selected = getSessionActorStorageBinding({});
    if (
      selected?.actor.target.sessionKey === sessionKey &&
      (!agentId || agentId === selected.agentId)
    ) {
      return createSessionActorProgressCardStore(() => selected).get(sessionKey, agentId);
    }
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    const scope = captureGatewaySessionStoreScope(sessionKey, agentId);
    if (isIncognitoSessionKey(scope.sessionKey)) {
      return (
        (await withSessionActorStorage(
          { ...scope, env },
          {
            lifetime: { assertCurrent() {}, assertReadable() {} },
            authority: { assertCurrent() {} },
          },
          (binding) =>
            createSessionActorProgressCardStore(() => binding).get(scope.sessionKey, scope.agentId),
        )) ?? null
      );
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
    const selected = getSessionActorStorageBinding({});
    if (
      selected?.actor.target.sessionKey === sessionKey &&
      (!agentId || agentId === selected.agentId)
    ) {
      return createSessionActorProgressCardStore(() => selected).put(sessionKey, input, agentId);
    }
    const capturedInput = structuredClone({
      markdown: input.markdown,
      steps: input.steps,
      expectedRevision: input.expectedRevision,
    });
    const assertCurrent = () => input.assertCurrent?.();
    const resolved = captureGatewaySessionStoreScope(sessionKey, agentId);
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    if (isIncognitoSessionKey(resolved.sessionKey)) {
      const result = await withSessionActorStorage(
        { ...resolved, env },
        {
          lifetime: { assertCurrent() {}, assertReadable() {} },
          authority: { assertCurrent: () => input.assertCurrent?.() },
        },
        (binding) =>
          createSessionActorProgressCardStore(() => binding).put(
            resolved.sessionKey,
            { ...capturedInput, assertCurrent },
            resolved.agentId,
          ),
      );
      if (!result) {
        throw new IncognitoSessionMissingError();
      }
      return result;
    }
    assertCurrent();
    const unsuffixed = resolveUnsuffixedSqliteTargetFromSessionStorePath(resolved.storePath);
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
