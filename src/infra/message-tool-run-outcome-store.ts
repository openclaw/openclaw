import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  resolveSqliteScope,
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { withSessionStoreTarget } from "../config/sessions/session-store-target-runtime.js";
import { withSessionHistoryWorkerReadCandidates } from "../config/sessions/session-transcript-worker-resources.js";
import { resolveStateDir } from "../config/state-dir.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { ensureMessageToolRunOutcomeSchema } from "../state/openclaw-agent-message-tool-outcome-schema.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "../state/openclaw-agent-worker-store.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import {
  recordMessageToolRunOutcomeInDatabase,
  type MessageToolRunOutcomeInsert,
} from "./message-tool-run-outcome-store.kernel.js";
import type { MessageToolRunOutcomeWorkerOperations } from "./message-tool-run-outcome-store.worker.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
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
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const scope = { ...params, env };
  if (
    isIncognitoSessionKey(scope.sessionKey) ||
    (scope.storePath && isIncognitoOpenClawAgentSqlitePath(scope.storePath, scope))
  ) {
    // Process-held incognito side data stays with its existing in-memory owner.
    const options = toDatabaseOptions(resolveSqliteScope(scope));
    ensureMessageToolRunOutcomeSchema(openOpenClawAgentDatabase(options).db);
    runOpenClawAgentWriteTransaction(
      ({ db }) => recordMessageToolRunOutcomeInDatabase(db, values),
      options,
      { operationLabel: "message-tool.run-outcome.record" },
    );
    return;
  }
  const storePath = scope.storePath ?? resolveOpenClawAgentSqlitePath(scope);
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = new Map(
    candidates
      .filter((candidate) => !candidate.scope)
      .map((candidate) => {
        const identity = readDatabasePathIdentitySync(candidate.path);
        return [identity.canonicalPath, identity] as const;
      }),
  );
  const admission = resolveSqliteWriteAdmissionScope({ ...scope, storePath });
  const shared = captureOpenClawStateReadContext(resolveOpenClawStateSqlitePath(env));
  // Retain discovery custody before queuing; close must not turn waiting work into a fresh open.
  await withSessionHistoryWorkerReadCandidates(candidates, async (custody) => {
    const assertCaptured = () => {
      custody.assertCurrent();
      shared.admission.assertCurrent();
    };
    const prepare = () =>
      withSessionStoreTarget(
        { agentId: scope.agentId, storePath, env, candidates },
        async (target, owner) => {
          const options = { ...target.database, env };
          const identity =
            identities.get(options.path) ?? readDatabasePathIdentitySync(options.path);
          if (!identities.has(options.path) && identity.key.startsWith("file:")) {
            throw new Error("Message-tool outcome target appeared after source capture");
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
                await worker.run(async (writer) => {
                  for (const command of [
                    { type: "prepare", input: undefined },
                    { type: "record", input: values },
                  ] as const) {
                    const result = await writer.execute(command);
                    if (!result.ok) {
                      const error = new Error("Message-tool outcome transaction failed");
                      retainOpenClawStateWorkerErrorPayload(error, result.error);
                      throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
                    }
                  }
                }, assertCurrent);
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
