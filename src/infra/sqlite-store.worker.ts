import { isPromise } from "node:util/types";
import { deserialize, serialize } from "node:v8";
import { parentPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SQLITE_WORKER_MAX_RESULT_BYTES,
  type SqliteWorkerBackend,
  type SqliteWorkerCommand,
  type SqliteWorkerOperations,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "./sqlite-worker-identity.js";
import {
  createSqliteWorkerTransferOwner,
  createSqliteWorkerTransferReceiver,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";

const port = parentPort;
if (!port) {
  throw new Error("SQLite store worker requires its host port");
}
const actors = new Map<number, SqliteWorkerBackend<SqliteWorkerOperations>>();
const transfers = createSqliteWorkerTransferOwner();
let pendingResult: { requestId: number; actor: number; transferId: number } | undefined;
type StagedInput = {
  requestId: number;
  actor: number;
  receiver: ReturnType<typeof createSqliteWorkerTransferReceiver>;
  command: unknown;
};
let pendingInput: StagedInput | undefined;
let sourceLoaderRegistered = false;

async function receive(request: SqliteWorkerRequest): Promise<void> {
  let reply: SqliteWorkerReply;
  let executed = pendingResult !== undefined;
  let retire = false;
  let completeResult = false;
  let inputNext = false;
  try {
    let value: unknown;
    const executeCommand = (command: unknown) => {
      const backend = actors.get(request.actor);
      if (!backend) {
        throw new Error("SQLite worker actor is closed");
      }
      // SAFETY: The typed host command is serialized once; framing validates complete reconstruction.
      value = backend.execute(command as SqliteWorkerCommand<SqliteWorkerOperations>);
      executed = true;
      completeResult = true;
      if (isPromise(value) || (isRecord(value) && typeof value.then === "function")) {
        retire = true;
        if (isPromise(value)) {
          // Retirement owns the failure; consume rejection while native exit is joined.
          void value.catch(() => {});
        }
        throw new Error("SQLite worker operations must remain synchronous");
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
        executeCommand(input.command);
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
      // Module loading can yield before the factory opens native state.
      if (request.existingIdentity) {
        assertExistingDatabaseIdentity(request.databasePath, request.existingIdentity);
      }
      const backend: unknown = await module[factoryName](deserialize(request.input), {
        databasePath: request.databasePath,
      });
      if (
        !isRecord(backend) ||
        typeof backend.execute !== "function" ||
        typeof backend.close !== "function"
      ) {
        throw new Error("SQLite worker module returned an invalid backend");
      }
      // SAFETY: The validated backend and its typed client own the private command contract.
      actors.set(request.actor, backend as SqliteWorkerBackend<SqliteWorkerOperations>);
    } else if (request.type === "close") {
      const backend = actors.get(request.actor);
      if (!backend) {
        throw new Error("SQLite worker actor is closed");
      }
      await backend.close();
      actors.delete(request.actor);
    } else {
      executeCommand(deserialize(request.input));
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
    transfers.cancel();
    pendingResult = undefined;
    pendingInput = undefined;
    const failure = error instanceof Error ? error : new Error(String(error));
    const code = executed ? "outcome-unknown" : "code" in failure ? failure.code : undefined;
    reply = {
      id: request.id,
      ok: false,
      ...(retire ? { retire: true } : {}),
      error: {
        name: executed ? "SqliteWorkerError" : failure.name,
        message: failure.message,
        ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
      },
    };
  }
  port!.postMessage(reply, []);
}

// The broker sends one request at a time, including module initialization.
port.on("message", (request: SqliteWorkerRequest) => void receive(request));
