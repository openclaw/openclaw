import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import type {
  SessionProfileInvolvementChange,
  SessionProfileInvolvementWorkerInput,
  SessionProfileInvolvementWorkerOperations,
  SessionProfileInvolvementWorkerResult,
} from "./session-accessor.sqlite-involvement.worker.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";

const log = createSubsystemLogger("sessions/involvement");

function reportAcknowledgedCleanupFailure(error: unknown): void {
  try {
    log.warn(`Session involvement completed before cleanup failed: ${formatErrorMessage(error)}`);
  } catch {
    // Diagnostics cannot turn an acknowledged result into a replayable mutation.
  }
}

/** One logical-node owner for explicit personal choices and committed mentions. */
export async function updateSessionProfileInvolvement(
  scope: SessionAccessScope & { database?: { agentId: string; path: string } },
  params: {
    expectedSessionId: string;
    profileIds: readonly string[];
    change: SessionProfileInvolvementChange;
    assertCurrent?: () => void;
    /** Registration can invalidate discovery; prepare the write guard after opening. */
    prepareMutation?: () => Promise<() => void>;
  },
): Promise<boolean> {
  const assertCallerCurrent = params.assertCurrent;
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  const stateDir = resolveStateDir(env);
  env.OPENCLAW_STATE_DIR = stateDir;
  const resolved = resolveSqliteScope({ ...scope, storePath: undefined, env });
  const selected = toDatabaseOptions(resolved);
  let options = { ...selected, path: resolveOpenClawAgentSqlitePath(selected), ...scope.database };
  if (scope.storePath && !scope.database) {
    const storePath = scope.storePath;
    const candidates = captureSessionStoreReadCandidates(storePath);
    const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
    const database = await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
      let target = await discovery.readStoreTarget({
        agentId: resolved.agentId,
        storePath,
        env,
        registeredDatabases: { status: "deferred" },
      });
      if (target.kind === "session-target-registry-required") {
        const registry = await registryRead.read();
        registry.assertCurrent();
        discovery.assertCurrent();
        target = await discovery.readStoreTarget({
          agentId: resolved.agentId,
          storePath,
          env,
          registeredDatabases:
            registry.result.status === "available"
              ? registry.result.entries
              : { status: "unavailable" },
        });
        registry.assertCurrent();
      }
      discovery.assertCurrent();
      assertCallerCurrent?.();
      if (target.kind !== "session-store-target") {
        throw new Error("Session involvement target is unavailable");
      }
      return target.database;
    });
    options = { ...options, ...database };
  }
  // Incognito never stores personal involvement and cannot be reopened in another isolate.
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    assertCallerCurrent?.();
    return false;
  }
  const command: SessionProfileInvolvementWorkerOperations["update"]["input"] = structuredClone({
    sessionKey: resolved.sessionKey,
    expectedSessionId: params.expectedSessionId,
    profileIds: [...new Set(params.profileIds)],
    change: params.change,
  });
  const input: SessionProfileInvolvementWorkerInput = {
    agentId: options.agentId,
    env: { OPENCLAW_STATE_DIR: stateDir },
  };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const createSource = (guard: (() => void) | undefined): AgentDatabaseRequestExecutionSource => {
    const assertCurrent = () => {
      execution.assertCurrent();
      guard?.();
    };
    return {
      assertCurrent,
      createAdmission(binding) {
        return () => {
          let phase: "waiting" | "transaction" | "commit" = "waiting";
          return {
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              assertCurrent();
              if (request.stage === "transaction" || request.stage === "commit") {
                if (
                  !(
                    (phase === "waiting" && request.stage === "transaction") ||
                    (phase === "transaction" && request.stage === "commit")
                  )
                ) {
                  throw new Error("Session involvement authority requested out of order");
                }
                phase = request.stage;
              }
              if (!grant()) {
                throw new Error("Session involvement authority expired");
              }
            }),
          };
        };
      },
    };
  };
  // Cleanup can retire only this exact binding, never authorize another durable operation.
  const cleanupSource: AgentDatabaseRequestExecutionSource = {
    assertCurrent: () => execution.assertCurrent(),
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "prepare") {
            throw new Error("Session involvement cleanup cannot admit a transaction");
          }
          binding.authorize(request);
          execution.assertCurrent();
          if (!grant()) {
            throw new Error("Session involvement cleanup authority expired");
          }
        }),
      });
    },
  };
  let acknowledged: SessionProfileInvolvementWorkerResult | undefined;
  const failures: unknown[] = [];
  let accepted = false;
  try {
    accepted = await runOpenClawAgentWorkerWrite(options, async () => {
      let assertMutationCurrent: (() => void) | undefined;
      if (params.prepareMutation) {
        const opened = await execution.runExisting(
          createSource(assertCallerCurrent),
          async () => true,
          { retireNativeOnFailure: true },
        );
        if (!opened) {
          return false;
        }
        assertMutationCurrent = await params.prepareMutation();
      }
      const source = createSource(() => {
        assertCallerCurrent?.();
        assertMutationCurrent?.();
      });
      source.assertCurrent();
      const id = randomUUID();
      let bound = false;
      let value = false;
      try {
        value =
          (await execution.runExisting(
            source,
            async (worker) => {
              await worker.execute({
                type: "database.domain.bind",
                input: {
                  id,
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.sessionProfileInvolvement,
                  ).href,
                  input,
                },
              });
              bound = true;
              const reply = await worker.execute({
                type: "database.domain.execute",
                input: { id, command: { type: "update", input: command } },
              });
              // SAFETY: The paired static worker owns this serialized command/result contract.
              const result = reply as SessionProfileInvolvementWorkerResult;
              acknowledged = result;
              if (result.changed) {
                sessionChanges.emit({
                  agentId: options.agentId,
                  storePath: execution.path,
                  sessionKey: resolved.sessionKey,
                });
                emitSessionLifecycleEvent({
                  agentId: resolved.agentId,
                  sessionKey: resolved.sessionKey,
                  reason: "involvement",
                });
              }
              return result.accepted;
            },
            { retireNativeOnFailure: true },
          )) ?? false;
      } catch (error) {
        failures.push(error);
      }
      if (bound) {
        try {
          await execution.runExisting(
            cleanupSource,
            (worker) => worker.execute({ type: "database.domain.close", input: { id } }),
            { retireNativeOnFailure: true },
          );
        } catch (error) {
          failures.push(error);
        }
      }
      return value;
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await execution.release();
  } catch (error) {
    failures.push(error);
  }
  if (acknowledged) {
    for (const failure of failures) {
      reportAcknowledgedCleanupFailure(failure);
    }
    return acknowledged.accepted;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length) {
    throw new AggregateError(failures, "Session involvement and cleanup failed", {
      cause: failures[0],
    });
  }
  return accepted;
}
