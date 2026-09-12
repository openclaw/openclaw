import { isPromise } from "node:util/types";
import { deserialize, serialize } from "node:v8";
import { parentPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SQLITE_WORKER_MAX_RESULT_BYTES,
  type SqliteWorkerBackend,
  type SqliteWorkerOperations,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "./sqlite-worker-identity.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";

const port = parentPort;
if (!port) {
  throw new Error("SQLite store worker requires its host port");
}
const actors = new Map<number, SqliteWorkerBackend<SqliteWorkerOperations>>();
const transfers = createSqliteWorkerTransferOwner();
let pendingResult: { requestId: number; actor: number; transferId: number } | undefined;
let sourceLoaderRegistered = false;

async function receive(request: SqliteWorkerRequest): Promise<void> {
  let reply: SqliteWorkerReply;
  let executed = pendingResult !== undefined;
  let retire = false;
  try {
    let value: unknown;
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
    } else {
      const backend = actors.get(request.actor);
      if (!backend) {
        throw new Error("SQLite worker actor is closed");
      }
      if (request.type === "close") {
        await backend.close();
        actors.delete(request.actor);
      } else {
        value = backend.execute(deserialize(request.input));
        executed = true;
        if (isPromise(value) || (isRecord(value) && typeof value.then === "function")) {
          retire = true;
          if (isPromise(value)) {
            // Retirement owns the failure; consume rejection while native exit is joined.
            void value.catch(() => {});
          }
          throw new Error("SQLite worker operations must remain synchronous");
        }
      }
    }
    const serialized = serialize(value);
    if (serialized.byteLength > SQLITE_WORKER_MAX_RESULT_BYTES) {
      if (request.type !== "execute") {
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
      };
    }
  } catch (error) {
    transfers.cancel();
    pendingResult = undefined;
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
