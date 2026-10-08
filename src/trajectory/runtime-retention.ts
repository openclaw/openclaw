import { setImmediate as nextTurn } from "node:timers/promises";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import {
  createSqliteReadOnlyWorkerScope,
  runSqliteReadOnlyOperation,
} from "../infra/sqlite-readonly-worker.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { retainAgentDatabase } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import type { AgentDatabaseExecutionScope } from "../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import type {
  TrajectoryRuntimeRetentionInput,
  TrajectoryRuntimeRetentionPlan,
} from "./runtime-retention.contract.js";
import {
  trajectoryRuntimeRetentionDue,
  trajectoryRuntimeRetentionState,
} from "./runtime-retention.sqlite.js";

const log = createSubsystemLogger("trajectory");

/** Preserve the native sweep policy without holding the actor's append transaction. */
export async function settleIncognitoTrajectoryRuntimeRetention(params: {
  actor: IncognitoSessionActor;
  authority: IncognitoSessionAuthority;
  input: TrajectoryRuntimeRetentionInput & { sessionKey: string };
}): Promise<void> {
  const buffer = new SharedArrayBuffer(4);
  const lease = new Int32Array(buffer);
  Atomics.store(lease, 0, 1);
  const now = Date.now();
  try {
    await params.actor.sessions.withSharedState(async () => {
      const prepare = () =>
        params.actor.sessions.sideData(
          params.authority,
          {
            type: "session.trajectory.retention.prepare",
            input: { ...params.input, now },
          },
          undefined,
          undefined,
          undefined,
          { trajectoryRetentionLease: buffer },
        );
      let prepared: { sweepId: string; snapshot?: TrajectoryRuntimeRetentionPlan } | undefined =
        await prepare();
      let refreshes = 0;
      while (prepared) {
        const result = await params.actor.sessions.sideData(params.authority, {
          type: "session.trajectory.retention.delete",
          input: { ...prepared, sessionKey: params.input.sessionKey, now },
        });
        if (result.complete) {
          break;
        }
        if (result.refresh) {
          if (++refreshes > 1) {
            break;
          }
          prepared = await prepare();
        } else {
          prepared = { ...prepared, snapshot: undefined };
        }
      }
    });
  } catch (error) {
    log.warn(`Trajectory retention deferred until the next append: ${String(error)}`);
  } finally {
    Atomics.store(lease, 0, 0);
  }
}

/** One lifecycle-owned sweep; reads never hold the canonical writer reservation. */
export function scheduleSqliteTrajectoryRuntimeRetention(params: {
  database: OpenClawAgentDatabase;
  options: OpenClawAgentDatabaseOptions;
  input: TrajectoryRuntimeRetentionInput;
  assertCurrent(this: void): void;
}): Promise<void> | undefined {
  const { database, options, assertCurrent: assertSourceCurrent } = params;
  const input = {
    sessionId: params.input.sessionId,
    maxGlobalRuntimeBytes: params.input.maxGlobalRuntimeBytes,
  };
  const state = trajectoryRuntimeRetentionState(database);
  if (state.pending) {
    return state.pending;
  }
  const now = Date.now();
  if (!trajectoryRuntimeRetentionDue(state, now)) {
    return undefined;
  }
  const identity = readOpenClawAgentDatabaseIdentity(database);
  const physicalIdentity = identity.identity;
  if (typeof physicalIdentity !== "string") {
    return undefined;
  }
  const controller = new AbortController();
  const lease = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(lease, 0, 1);
  controller.signal.addEventListener("abort", () => Atomics.store(lease, 0, 0), { once: true });
  let release: (() => void) | undefined;
  let unregister: (() => void) | undefined;
  let unregisterRoot: (() => void) | undefined;
  const close = async () => {
    controller.abort();
    await state.pending;
  };
  let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
  let reader: ReturnType<typeof createSqliteReadOnlyWorkerScope> | undefined;
  const cleanup = async () => {
    Atomics.store(lease, 0, 0);
    const outcomes = await Promise.allSettled([reader?.close(), execution?.release()]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "Trajectory retention cleanup failed");
    }
    unregisterRoot?.();
    unregister?.();
    release?.();
    state.pending = undefined;
  };
  const observeFailure = (error: unknown) => {
    log.warn(`Trajectory retention cleanup failed: ${String(error)}`);
  };
  try {
    release = retainAgentDatabase(database.db);
    unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: database.agentId,
      path: database.path,
      revoke: () => controller.abort(),
      close,
    });
    execution = captureOpenClawAgentDatabaseExecution(options, {
      expectedIdentity: {
        kind: "file",
        physicalIdentity,
        birthtime: identity.birthtime,
        nativeLocation: identity.filename,
      },
    });
    const root = captureOpenClawStateReadContext(resolveOpenClawStateSqlitePath(options.env));
    unregisterRoot = registerOpenClawStateDatabaseAsyncResource({
      close: async (closed) => {
        if (!closed || closed.key === root.admission.identity.key) {
          await close();
        }
      },
    });
    reader = createSqliteReadOnlyWorkerScope({
      signal: controller.signal,
      deadlineOwnedByCaller: false,
    });
  } catch (error) {
    log.warn(`Trajectory retention deferred until the next append: ${String(error)}`);
    state.pending = cleanup();
    void state.pending.catch(observeFailure);
    return state.pending;
  }
  const retained = execution;
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    retained.assertCurrent();
    assertSourceCurrent();
  };
  const retainedReader = reader;
  const execute = async <T>(operation: (worker: AgentDatabaseExecutionScope) => Promise<T>) => {
    assertCurrent();
    const result = await runOpenClawAgentWorkerWrite(
      options,
      () =>
        retained.runExisting(
          {
            assertCurrent,
            createAdmission: (binding) => () => ({
              nativeLocations: binding.nativeLocations,
              admission: createSqliteWorkerOperationAdmission(
                (request, grant) => {
                  binding.authorize(request);
                  assertCurrent();
                  if (!grant()) {
                    throw new Error("Trajectory retention authority expired");
                  }
                },
                { ...binding.attachment, trajectoryRetentionLease: lease.buffer },
              ),
            }),
          },
          operation,
        ),
      undefined,
      controller.signal,
    );
    if (result === undefined) {
      throw new Error("Trajectory retention database disappeared before deletion");
    }
    return result;
  };
  state.pending = runInDetachedAsyncContext(() =>
    retainedReader.run(async () => {
      try {
        await nextTurn(undefined, { signal: controller.signal });
        let refreshes = 0;
        let sweepId = await execute((worker) =>
          worker.execute({ type: "trajectory.retention.begin", input: undefined }),
        );
        let snapshot: TrajectoryRuntimeRetentionPlan | undefined;
        let needsRead = true;
        for (;;) {
          assertCurrent();
          if (needsRead) {
            snapshot = await runSqliteReadOnlyOperation(
              database.path,
              {
                type: "trajectoryRetention.read",
                input: { ...input, agentId: database.agentId, now },
              },
              {
                source: "canonical",
                expectedIdentity: `file:${physicalIdentity}`,
                env: options.env ?? process.env,
                signal: controller.signal,
              },
            );
            needsRead = false;
          }
          const result = await execute((worker) =>
            worker.execute({
              type: "trajectory.retention.delete",
              input: { sweepId, snapshot },
            }),
          );
          snapshot = undefined;
          if (result.complete) {
            state.sweptAt = now;
            break;
          }
          if (result.refresh) {
            if (++refreshes > 1) {
              break;
            }
            sweepId = await execute((worker) =>
              worker.execute({ type: "trajectory.retention.begin", input: undefined }),
            );
            needsRead = true;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          log.warn(`Trajectory retention deferred until the next append: ${String(error)}`);
        }
      } finally {
        await cleanup();
      }
    }),
  );
  void state.pending.catch(observeFailure);
  return state.pending;
}
