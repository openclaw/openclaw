import { err, ok } from "@openclaw/normalization-core/result";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  prepareSessionStoreReaderCandidates,
  withSessionStoreTarget,
} from "../config/sessions/session-store-target-runtime.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { createSessionWorkerExecutionSource } from "../config/sessions/session-worker-execution-source.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readDatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import type { ProgressCardStore } from "../session-cards/progress-card-store.types.js";
import type { ProgressCardWorkerOperations } from "../session-cards/progress-card-store.worker.js";
import { createSessionActorProgressCardStore } from "../session-cards/session-actor-progress-card-store.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import { toAgentExecutionConstraints } from "../state/openclaw-agent-execution-scope.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../state/openclaw-agent-execution.js";
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

function captureProgressCardTarget(
  sessionKey: string,
  agentId?: string,
  assertCallerCurrent?: () => void,
) {
  const scope = captureGatewaySessionStoreScope(sessionKey, agentId);
  const assertCurrent = () => {
    assertCallerCurrent?.();
  };
  return { scope, assertCurrent };
}

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
    const { scope, assertCurrent } = captureProgressCardTarget(sessionKey, agentId);
    if (isIncognitoSessionKey(scope.sessionKey)) {
      return (
        (await withSessionActorStorage(
          { ...scope, env },
          {
            lifetime: { assertCurrent, assertReadable: assertCurrent },
            authority: { assertCurrent, authorize: assertCurrent },
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
    const { scope: resolved, assertCurrent } = captureProgressCardTarget(
      sessionKey,
      agentId,
      input.assertCurrent,
    );
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    if (isIncognitoSessionKey(resolved.sessionKey)) {
      const result = await withSessionActorStorage(
        { ...resolved, env },
        {
          lifetime: { assertCurrent, assertReadable: assertCurrent },
          authority: { assertCurrent, authorize: assertCurrent },
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
    const captured = (async () => {
      const { candidates } = await prepareSessionStoreReaderCandidates(resolved.storePath, {
        inspection: false,
        allowDirect: false,
      });
      const identities = new Map(
        await Promise.all(
          candidates
            .filter((candidate) => !candidate.scope)
            .map(async (candidate) => {
              const identity = await readDatabasePathIdentity(candidate.path);
              return [identity.canonicalPath, identity] as const;
            }),
        ),
      );
      return { candidates, identities };
    })().then(
      (value) => ok(value),
      (error: unknown) => err<never, unknown>(error),
    );
    const persist = async () => {
      const qualification = await captured;
      if (!qualification.ok) {
        throw qualification.error;
      }
      const { candidates, identities } = qualification.value;
      const prepare = () =>
        withSessionStoreTarget(
          { ...resolved, env, candidates },
          async (target, owner) => {
            const options = { ...target.database, env };
            const identity =
              identities.get(options.path) ?? (await readDatabasePathIdentity(options.path));
            if (!identities.has(options.path) && identity.key.startsWith("file:")) {
              throw new Error("Progress-card target appeared after source capture");
            }
            const execution = await captureOpenClawAgentDatabaseExecutionAsync(
              options,
              toAgentExecutionConstraints(identity),
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
                      ...createSessionWorkerExecutionSource(
                        assertOwnerCurrent,
                        "Progress-card preparation authority expired",
                        [owner.readCustody],
                      ),
                      onRegistryChange: owner.onRegistryChange,
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
                        readCustody: [owner.readCustody],
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
        custody.assertCurrent();
        return prepare();
      });
      return "card" in result ? result : { card: null };
    };
    // Reserve the existing FIFO before asynchronous filesystem qualification can reorder calls.
    return unsuffixed.agentId || unsuffixed.shared
      ? runOpenClawAgentWriteAdmission(
          { agentId: resolved.agentId, path: unsuffixed.path, env },
          persist,
          true,
        )
      : persist();
  },
};
