import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { withSessionStoreTarget } from "../config/sessions/session-store-target-runtime.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import { resolveStateDir } from "../config/state-dir.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "../state/openclaw-agent-worker-store.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import type { MessageToolRunOutcomeInsert } from "./message-tool-run-outcome-store.kernel.js";
import type { MessageToolRunOutcomeWorkerOperations } from "./message-tool-run-outcome-store.worker.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

/** Records one bounded completion fact before the run's owner retires. */
export async function recordMessageToolRunOutcome(params: {
  runId: string;
  sessionKey: string;
  agentId: string;
  provider: string;
  model: string;
  outcome: "tool_delivered" | "mute";
  runStatus: "completed" | "errored" | "aborted";
  occurredAt: number;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  sessionActor?: SessionActorStorageBinding;
}): Promise<void> {
  const values: MessageToolRunOutcomeInsert = {
    run_id: params.runId,
    session_key: params.sessionKey,
    agent_id: params.agentId,
    provider: params.provider,
    model: params.model,
    outcome: params.outcome,
    run_status: params.runStatus,
    occurred_at: params.occurredAt,
  };
  const authority = { assertCurrent() {}, authorize() {} };
  const memory = captureSessionActorStorageOwner(params, authority);
  if (memory) {
    const recorded = await withSessionActorStorage(
      params,
      {
        authority,
        lifetime: {
          assertCurrent: () => authority.assertCurrent(),
          assertReadable: () => authority.assertCurrent(),
        },
      },
      async ({ actor, authority: selectedAuthority }) => {
        const result = await actor.storage.mutate(
          { type: "session.messageToolOutcome.record", input: values },
          selectedAuthority,
        );
        if (result.kind === "rolled-back") {
          throw new Error(result.error.message);
        }
        return true;
      },
    );
    // Closing an incognito session discards late bookkeeping; the run owner records the warning.
    if (!recorded) {
      throw new IncognitoSessionMissingError();
    }
    return;
  }
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = { ...params, env };
  const storePath = scope.storePath ?? resolveOpenClawAgentSqlitePath(scope);
  const candidates = captureSessionStoreReadCandidates(storePath);
  const admission = resolveSqliteWriteAdmissionScope({ ...scope, storePath });
  // Retain discovery custody before queuing; close must not turn waiting work into a fresh open.
  await withSessionHistoryWorkerReadCandidates(candidates, async (custody) => {
    const assertCaptured = () => custody.assertCurrent();
    const prepare = () =>
      withSessionStoreTarget(
        { agentId: scope.agentId, storePath, env, candidates },
        async (target, owner) => {
          const options = { ...target.database, env };
          const execution = captureOpenClawAgentDatabaseExecution(options);
          const assertCurrent = () => {
            assertCaptured();
            owner.assertCurrent();
            execution.assertCurrent();
          };
          const failures: unknown[] = [];
          let worker:
            | OpenClawAgentSqliteWorkerStore<MessageToolRunOutcomeWorkerOperations>
            | undefined;
          try {
            await runOpenClawAgentWriteAdmission(
              options,
              async () => {
                await owner.refreshBeforeDispatch(() => execution.assertCurrent());
                await runOpenClawAgentWorkerWrite(options, () =>
                  execution.prepare({
                    assertCurrent,
                    onRegistryChange: owner.onRegistryChange,
                    createAdmission(binding) {
                      return () => ({
                        nativeLocations: binding.nativeLocations,
                        admission: createSqliteWorkerOperationAdmission((request, grant) => {
                          binding.authorize(request);
                          assertCurrent();
                          if (!grant()) {
                            throw new Error("Message-tool outcome preparation authority expired");
                          }
                        }, binding.attachment),
                      });
                    },
                  }),
                );
                await owner.revalidateTarget();
                worker =
                  await openOpenClawAgentSqliteWorkerStore<MessageToolRunOutcomeWorkerOperations>(
                    options,
                    { execution },
                    {
                      moduleUrl: resolveRuntimeWorkerUrl(
                        runtimeProcessEntrypoints.messageToolRunOutcomeStore,
                      ),
                      input: undefined,
                    },
                  );
                const result = await worker.execute(
                  { type: "record", input: values },
                  assertCurrent,
                );
                if (!result.ok) {
                  const error = new Error("Message-tool outcome transaction failed");
                  retainOpenClawStateWorkerErrorPayload(error, result.error);
                  throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
                }
              },
              true,
            );
          } catch (error) {
            failures.push(error);
          } finally {
            for (const close of [() => worker?.close(), () => execution.release()]) {
              try {
                await close();
              } catch (error) {
                failures.push(error);
              }
            }
          }
          throwSqliteLifecycleErrors(failures, "Message-tool outcome recording and cleanup failed");
        },
        assertCaptured,
      );
    if (admission) {
      await runOpenClawAgentWriteAdmission(toDatabaseOptions(admission), prepare, true);
    } else {
      await prepare();
    }
  });
}
