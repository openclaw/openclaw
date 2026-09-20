import { isPromise } from "node:util/types";
import { deserialize, serialize } from "node:v8";
import { type MessagePort, parentPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { routeLogsToStderr } from "../logging/console.js";
import { drainProcessOutput } from "../process/output-drain.js";
import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import {
  SQLITE_WORKER_MAX_RESULT_BYTES,
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "./sqlite-worker-identity.js";
import { acquireSqliteWorkerLifecycle } from "./sqlite-worker-lifecycle-preparation.js";
import {
  withSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
  settleSqliteWorkerOperationContext,
  type SqliteWorkerOperationContext,
} from "./sqlite-worker-operation-admission.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "./sqlite-worker-state-context.js";
import {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";
import {
  attachGatewaySchemaFenceDelegate,
  attachStateLifecycleDelegate,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";
import type { acquireStateDatabaseCoordinator } from "./state-database-coordinator.js";
import { ownedWorkerBytes } from "./worker-transfer-bytes.js";

const port = parentPort;
if (!port) {
  throw new Error("SQLite store worker requires its host port");
}
// Results use the host port; diagnostics must preserve the caller's structured stdout.
routeLogsToStderr();
const actors = new Map<number, SqliteWorkerPreparedBackend<SqliteWorkerOperations>>();
const transfers = createSqliteWorkerTransferOwner();
let pendingResult: { requestId: number; actor: number; transferId: number } | undefined;
type StagedInput = {
  requestId: number;
  actor: number;
  receiver: ReturnType<typeof createSqliteWorkerTransferReceiver>;
  command: unknown;
};
let pendingInput: StagedInput | undefined;
const actorPaths = new Map<number, string>();
const stateContexts = new Map<number, SqliteWorkerStateContext>();
const gatewayFences = new Map<
  number,
  Awaited<ReturnType<typeof attachGatewaySchemaFenceDelegate>>
>();
let sourceLoaderRegistered = false;
let preparedGatewayActor: number | undefined;
let lifecycleReply: { actor: number; port: MessagePort } | undefined;
let nativeCleanupFailure: OpenClawStateWorkerErrorPayload | undefined;
let lifecyclePreparation: { actor: number; port: MessagePort; deadlineNs: bigint } | undefined;
let operationAdmission: { actor: number; context: SqliteWorkerOperationContext } | undefined;
// Input and result continuations retain the original job's delegation.
let lifecycle:
  | {
      actor: number;
      delegate: Awaited<ReturnType<typeof attachStateLifecycleDelegate>>;
    }
  | undefined;
let maintenanceFence:
  | {
      actor: number;
      delegate: Awaited<ReturnType<typeof attachGatewaySchemaFenceDelegate>>;
    }
  | undefined;

function runInActorContext<T>(actor: number, operation: () => T): T {
  const runAdmitted = () =>
    operationAdmission?.actor === actor
      ? withSqliteWorkerOperationAdmission(operationAdmission.context, operation)
      : operation();
  const context = stateContexts.get(actor);
  if (!context) {
    return runAdmitted();
  }
  return withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
    runWithSqliteWorkerStateContext(context, () => {
      const delegate =
        maintenanceFence?.actor === actor ? maintenanceFence.delegate : gatewayFences.get(actor);
      const run = () => (delegate ? delegate.run(runAdmitted) : runAdmitted());
      return lifecycle?.actor === actor ? lifecycle.delegate.run(run) : run();
    }),
  );
}

async function receive(request: SqliteWorkerRequest): Promise<void> {
  let reply: SqliteWorkerReply;
  let executed = pendingResult !== undefined;
  let retire = false;
  let completeResult = false;
  let inputNext = false;
  let openNotEntered = false;
  try {
    let value: unknown;
    if (request.type !== "result-next" && request.type !== "execute-frame") {
      if (request.lifecyclePreparation) {
        if (lifecyclePreparation || !request.workerStateLifecycle) {
          throw new Error("SQLite lifecycle preparation differs from its job");
        }
        lifecyclePreparation = {
          actor: request.actor,
          port: request.lifecyclePreparation,
          deadlineNs: request.workerStateLifecycle.deadlineNs,
        };
      }
      if (request.operationAdmission) {
        if (operationAdmission) {
          throw new Error("SQLite operation admission still belongs to the preceding operation");
        }
        operationAdmission = {
          actor: request.actor,
          context: { port: request.operationAdmission },
        };
      }
      if (request.stateContext) {
        stateContexts.set(request.actor, request.stateContext);
      }
      if (request.stateLifecycle) {
        retire = true;
        const context = stateContexts.get(request.actor);
        const databasePath =
          request.type === "open" ? request.databasePath : actorPaths.get(request.actor);
        if (lifecycle || !context || !databasePath) {
          throw new Error("State lifecycle delegate requires its admitting operation");
        }
        lifecycle = {
          actor: request.actor,
          delegate: await attachStateLifecycleDelegate(request.stateLifecycle, {
            databasePath,
            runtimeDirectory: context.coordinatorRuntime.directory,
            actorId: `${request.actor}:${request.id}`,
          }),
        };
        retire = false;
      }
      if (request.gatewaySchemaFence) {
        retire = true;
        if (gatewayFences.has(request.actor) || !request.stateContext) {
          throw new Error("Gateway schema delegate does not match an admitting shared-state actor");
        }
        const databasePath =
          request.type === "open" ? request.databasePath : actorPaths.get(request.actor);
        if (!databasePath) {
          throw new Error("Gateway schema delegate requires its open actor");
        }
        gatewayFences.set(
          request.actor,
          await attachGatewaySchemaFenceDelegate(request.gatewaySchemaFence, {
            databasePath,
            runtimeDirectory: request.stateContext.coordinatorRuntime.directory,
            actorId: String(request.actor),
          }),
        );
        if (request.workerStateLifecycle) {
          preparedGatewayActor = request.actor;
        }
        retire = false;
      }
      if (request.maintenanceSchemaFence) {
        retire = true;
        const context = stateContexts.get(request.actor);
        const databasePath =
          request.type === "open" ? request.databasePath : actorPaths.get(request.actor);
        if (maintenanceFence || !context || !databasePath) {
          throw new Error("Maintenance schema delegate requires its admitting operation");
        }
        maintenanceFence = {
          actor: request.actor,
          delegate: await attachGatewaySchemaFenceDelegate(request.maintenanceSchemaFence, {
            databasePath,
            runtimeDirectory: context.coordinatorRuntime.directory,
            actorId: `${request.actor}:${request.id}`,
          }),
        };
        retire = false;
      }
    }
    const executeCommand = async (command: unknown) => {
      let coordinator: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
      if (lifecyclePreparation) {
        const context = stateContexts.get(request.actor);
        const databasePath = actorPaths.get(request.actor);
        if (lifecyclePreparation.actor !== request.actor || !context || !databasePath) {
          throw new Error("SQLite lifecycle preparation lost its captured actor");
        }
        const preparation = lifecyclePreparation;
        lifecyclePreparation = undefined;
        lifecycleReply = { actor: request.actor, port: preparation.port };
        const prepared = await acquireSqliteWorkerLifecycle({
          port: preparation.port,
          databasePath,
          deadlineNs: preparation.deadlineNs,
          runtime: context.coordinatorRuntime,
          onUnsettled: () => {
            retire = true;
          },
        });
        coordinator = prepared.coordinator;
        if (prepared.admission) {
          operationAdmission = { actor: request.actor, context: { port: prepared.admission } };
        }
      }
      const backend = actors.get(request.actor);
      if (!backend) {
        throw new Error("SQLite worker actor is closed");
      }
      preparedGatewayActor = undefined;
      const assertSettled = (failure?: { error: unknown }) => {
        try {
          const settlement: unknown = runInActorContext(request.actor, () =>
            backend.assertSettled?.(),
          );
          if (
            isPromise(settlement) ||
            (isRecord(settlement) && typeof settlement.then === "function")
          ) {
            if (isPromise(settlement)) {
              void settlement.catch(() => {});
            }
            throw new Error("SQLite worker settlement checks must remain synchronous");
          }
          return backend.assertSettled !== undefined;
        } catch (error) {
          if (operationAdmission) {
            settleSqliteWorkerOperationContext(operationAdmission.context, "unknown");
          }
          // The broker joins native exit before settling this operation's admission.
          retire = true;
          if (failure && failure.error !== error) {
            throw new AggregateError(
              [failure.error, error],
              `${String(failure.error)}; SQLite worker settlement failed: ${String(error)}`,
              { cause: error },
            );
          }
          throw error;
        }
      };
      try {
        // SAFETY: The broker serialized a command from this actor's typed store contract.
        const typedCommand = command as SqliteWorkerCommand<SqliteWorkerOperations>;
        const preparation = backend[SQLITE_WORKER_PREPARE_COMMAND]?.(typedCommand.type);
        if (preparation) {
          await preparation;
        }
        try {
          value = runInActorContext(request.actor, () =>
            withSqliteReaderOwner(
              {
                operation: typedCommand.type,
                ownerKind: "worker",
                actorId: request.actor,
              },
              () => ({
                // SAFETY: The typed host command is serialized once; framing validates complete reconstruction.
                result: backend.execute(typedCommand),
              }),
            ),
          ).result;
        } catch (error) {
          const verified = assertSettled({ error });
          if (operationAdmission) {
            settleSqliteWorkerOperationContext(
              operationAdmission.context,
              verified ? "completed" : "unknown",
            );
          }
          throw error;
        }
        executed = true;
        completeResult = true;
        if (isPromise(value) || (isRecord(value) && typeof value.then === "function")) {
          retire = true;
          if (operationAdmission) {
            settleSqliteWorkerOperationContext(operationAdmission.context, "unknown");
          }
          if (isPromise(value)) {
            // Retirement owns the failure; consume rejection while native exit is joined.
            void value.catch(() => {});
          }
          throw new Error("SQLite worker operations must remain synchronous");
        }
        const verified = assertSettled();
        if (operationAdmission) {
          settleSqliteWorkerOperationContext(
            operationAdmission.context,
            verified ? "completed" : "unknown",
          );
        }
      } finally {
        // No write-capable continuation may outlive this lease. A failed
        // settlement retains the native owner until the broker joins worker exit.
        if (coordinator && !retire) {
          try {
            coordinator.release();
          } catch (error) {
            // The operation already settled. Retain its result and this native
            // custody until the host receives the complete reply and joins exit.
            const failure = error instanceof Error ? error : new Error(String(error));
            nativeCleanupFailure = encodeOpenClawStateWorkerError(failure, {
              includeOrdinary: true,
            });
          }
        }
      }
    };
    if (request.type === "result-next") {
      if (
        pendingResult?.requestId !== request.id ||
        pendingResult.actor !== request.actor ||
        pendingResult.transferId !== request.transferId
      ) {
        throw new Error("SQLite worker result transfer is no longer current");
      }
      executed = true;
      const frame = transfers.next(request.transferId);
      if (frame.done) {
        transfers.end(request.transferId);
        pendingResult = undefined;
      }
      value = frame;
    } else if (pendingResult) {
      throw new Error("SQLite worker result transfer has not finished");
    } else if (request.type === "execute-start") {
      retire = true;
      if (
        pendingInput ||
        !actors.has(request.actor) ||
        request.transfer.kinds.length !== 1 ||
        request.transfer.kinds[0] !== "command"
      ) {
        throw new Error("SQLite worker received unexpected command staging");
      }
      const input: StagedInput = {
        requestId: request.id,
        actor: request.actor,
        command: undefined,
        receiver: createSqliteWorkerTransferReceiver(request.transfer, (record) => {
          input.command = record.value;
        }),
      };
      pendingInput = input;
      inputNext = true;
      retire = false;
    } else if (request.type === "execute-frame") {
      retire = true;
      const input = pendingInput;
      if (!input || input.requestId !== request.id || input.actor !== request.actor) {
        throw new Error("SQLite worker command staging is no longer current");
      }
      // SAFETY: The matching host emits frames; the shared receiver validates sequence and bounds.
      const frame = deserialize(request.input) as SqliteWorkerTransferFrame;
      const counts = input.receiver.accept(frame);
      if (counts) {
        if (counts.length !== 1 || counts[0]?.[1] !== 1) {
          throw new Error("SQLite worker received an incomplete command");
        }
        pendingInput = undefined;
        retire = false;
        await executeCommand(input.command);
      } else {
        inputNext = true;
        retire = false;
      }
    } else if (pendingInput) {
      retire = true;
      throw new Error("SQLite worker command staging has not finished");
    } else if (request.type === "open") {
      if (actors.has(request.actor)) {
        throw new Error("SQLite worker actor is already open");
      }
      if (request.existingIdentity) {
        assertExistingDatabaseIdentity(request.databasePath, request.existingIdentity);
      }
      if (!sourceLoaderRegistered && request.sourceLoaderUrl) {
        const loader: unknown = await import(request.sourceLoaderUrl);
        if (!isRecord(loader) || typeof loader.register !== "function") {
          throw new Error("SQLite source worker loader is unavailable");
        }
        loader.register();
        sourceLoaderRegistered = true;
      }
      const module: unknown = await import(request.moduleUrl);
      const factoryName = request.existingIdentity
        ? "openExistingSqliteWorkerBackend"
        : "createSqliteWorkerBackend";
      if (!isRecord(module) || typeof module[factoryName] !== "function") {
        throw new Error(`SQLite worker module must export ${factoryName}`);
      }
      const factory = module[factoryName];
      // Module loading can yield before the factory opens native state.
      if (request.existingIdentity) {
        assertExistingDatabaseIdentity(request.databasePath, request.existingIdentity);
      }
      const backend: unknown = await runInActorContext(request.actor, () => {
        const input = deserialize(request.input);
        if (request.operationAdmission) {
          try {
            requestSqliteWorkerOperationAdmission({ stage: "open", facts: undefined });
          } catch (error) {
            openNotEntered = true;
            throw error;
          }
        }
        return factory(input, { databasePath: request.databasePath });
      });
      if (
        !isRecord(backend) ||
        typeof backend.execute !== "function" ||
        typeof backend.close !== "function" ||
        (SQLITE_WORKER_PREPARE_COMMAND in backend &&
          backend[SQLITE_WORKER_PREPARE_COMMAND] !== undefined &&
          typeof backend[SQLITE_WORKER_PREPARE_COMMAND] !== "function") ||
        (backend.assertSettled !== undefined && typeof backend.assertSettled !== "function")
      ) {
        throw new Error("SQLite worker module returned an invalid backend");
      }
      // SAFETY: The validated backend and its typed client own the private command contract.
      actors.set(request.actor, backend as SqliteWorkerPreparedBackend<SqliteWorkerOperations>);
      actorPaths.set(request.actor, request.databasePath);
    } else if (request.type === "close") {
      const backend = actors.get(request.actor);
      if (!backend) {
        throw new Error("SQLite worker actor is closed");
      }
      await runInActorContext(request.actor, () => backend.close());
      actors.delete(request.actor);
      actorPaths.delete(request.actor);
      stateContexts.delete(request.actor);
      gatewayFences.get(request.actor)?.close();
      gatewayFences.delete(request.actor);
    } else {
      await executeCommand(deserialize(request.input));
    }
    const serialized = serialize(value);
    if (serialized.byteLength > SQLITE_WORKER_MAX_RESULT_BYTES) {
      if (!completeResult) {
        throw new Error("SQLite worker frame exceeds the transport byte limit");
      }
      const handle = transfers.start([{ kind: "result", serialized }].values(), {
        kinds: ["result"],
      });
      pendingResult = { requestId: request.id, actor: request.actor, transferId: handle.id };
      reply = { id: request.id, ok: true, value: serialize(handle), transfer: "start" };
    } else {
      reply = {
        id: request.id,
        ok: true,
        value: serialized,
        ...(request.type === "result-next" ? { transfer: "frame" } : {}),
        ...(inputNext ? { input: "next" } : {}),
      };
    }
  } catch (error) {
    if (preparedGatewayActor !== undefined) {
      gatewayFences.get(preparedGatewayActor)?.close();
      gatewayFences.delete(preparedGatewayActor);
      preparedGatewayActor = undefined;
    }
    transfers.cancel();
    pendingResult = undefined;
    pendingInput = undefined;
    const failure = error instanceof Error ? error : new Error(String(error));
    const code = executed ? "outcome-unknown" : "code" in failure ? failure.code : undefined;
    const errorContext =
      request.stateContext ??
      (request.type === "execute-frame" ? stateContexts.get(request.actor) : undefined);
    const sharedState =
      errorContext && !executed ? encodeOpenClawStateWorkerError(failure) : undefined;
    reply = {
      id: request.id,
      ok: false,
      ...(retire || (nativeCleanupFailure && executed) ? { retire: true } : {}),
      ...(openNotEntered ? { openNotEntered: true } : {}),
      error: {
        name: executed ? "SqliteWorkerError" : failure.name,
        message: failure.message,
        ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
        ...(sharedState ? { sharedState } : {}),
      },
    };
  }
  if (!reply.ok || (!pendingInput && !pendingResult)) {
    maintenanceFence?.delegate.close();
    maintenanceFence = undefined;
    lifecycle?.delegate.close();
    lifecycle = undefined;
    lifecyclePreparation?.port.close();
    lifecyclePreparation = undefined;
    operationAdmission?.context.port.close();
    operationAdmission = undefined;
  }
  if (request.type === "close" && reply.ok && actors.size === 0) {
    // The broker can terminate this worker as soon as the final close is acknowledged.
    await new Promise<void>((resolve) => {
      drainProcessOutput(resolve);
    });
  }
  const complete = !reply.ok || (!pendingInput && !pendingResult);
  if (complete && nativeCleanupFailure) {
    reply.cleanupFailure = nativeCleanupFailure;
    nativeCleanupFailure = undefined;
  }
  const resultPort = lifecycleReply?.actor === request.actor ? lifecycleReply.port : undefined;
  if (reply.ok) {
    const bytes = ownedWorkerBytes(reply.value);
    const outgoing = { ...reply, value: bytes };
    if (resultPort) {
      resultPort.postMessage({ type: "result", reply: outgoing }, [bytes.buffer]);
    } else {
      port!.postMessage(outgoing, [bytes.buffer]);
    }
  } else if (resultPort) {
    resultPort.postMessage({ type: "result", reply }, []);
  } else {
    port!.postMessage(reply, []);
  }
  if (complete) {
    resultPort?.close();
    lifecycleReply = undefined;
  }
}

// The broker sends one request at a time, including module initialization.
port.on("message", (request: SqliteWorkerRequest) => void receive(request));
