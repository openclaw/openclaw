import { setImmediate as nextTurn } from "node:timers/promises";
import {
  MessagePort,
  MessageChannel,
  parentPort,
  SHARE_ENV,
  setEnvironmentData,
  Worker,
  workerData,
  type Transferable,
} from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { attachBrokerNativeResource } from "../process/spawn-broker/resource-client.js";
import { BrokerNativeResourceCloseError } from "../process/spawn-broker/resource-protocol.js";
import { serveWorkerMemorySamples } from "./worker-memory.js";
import { encodeNativeWorkerFailure } from "./worker-native-error.js";
import type { NativeWorkerReply, NativeWorkerRequest } from "./worker-native-lifecycle.types.js";
import { WORKER_TASK_PORT_MESSAGE } from "./worker-task-transport.js";

if (!isRecord(workerData) || !(workerData.port instanceof MessagePort)) {
  throw new Error("Native worker lifetime owner requires its private port");
}
const port = workerData.port;
if (parentPort) {
  serveWorkerMemorySamples(parentPort);
}
type NativeLifetime = {
  worker: Worker;
  joined: boolean;
  nativeJoined?: { code: number };
  termination?: Promise<number>;
  closing?: Promise<void>;
  resource?: {
    port: MessagePort;
    owner: ReturnType<typeof attachBrokerNativeResource>;
  };
};
const workers = new Map<number, NativeLifetime>();

type NativeWorkerReplyInput<Reply = NativeWorkerReply> = Reply extends { error: unknown }
  ? Omit<Reply, "error"> & { error: unknown }
  : Reply;

function send(reply: NativeWorkerReplyInput, transferList: Transferable[] = []): void {
  const message =
    "error" in reply && !(reply.type === "stop-error" && reply.resourceError)
      ? { ...reply, error: encodeNativeWorkerFailure(reply.error) }
      : reply;
  port.postMessage(message, transferList);
}

/** Values have already crossed a structured-clone boundary; forward transferred ownership. */
function transfers(value: unknown): Transferable[] {
  const transferred = new Set<Transferable>();
  const visited = new Set<object>();
  const visit = (current: unknown) => {
    if (typeof current !== "object" || current === null || visited.has(current)) {
      return;
    }
    visited.add(current);
    if (current instanceof MessagePort || current instanceof ArrayBuffer) {
      transferred.add(current);
    } else if (ArrayBuffer.isView(current)) {
      visit(current.buffer);
    } else if (current instanceof Map) {
      for (const [key, entry] of current) {
        visit(key);
        visit(entry);
      }
    } else if (current instanceof Set) {
      for (const entry of current) {
        visit(entry);
      }
    } else if (!(current instanceof SharedArrayBuffer)) {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
        if ("value" in descriptor) {
          visit(descriptor.value);
        }
      }
    }
  };
  visit(value);
  return [...transferred];
}

function stop(id: number, lifetime: NativeLifetime): void {
  if (lifetime.nativeJoined) {
    finishJoined(id, lifetime);
    return;
  }
  if (lifetime.joined || lifetime.termination) {
    return;
  }
  try {
    lifetime.termination = lifetime.worker.terminate();
    void lifetime.termination.catch((error: unknown) => {
      lifetime.termination = undefined;
      send({ type: "stop-error", id, error });
    });
  } catch (error) {
    send({ type: "stop-error", id, error });
  }
}

function finishJoined(id: number, lifetime: NativeLifetime): void {
  const nativeJoined = lifetime.nativeJoined;
  if (!nativeJoined || lifetime.joined || lifetime.closing) {
    return;
  }
  lifetime.closing = (async () => {
    const resource = lifetime.resource;
    if (resource) {
      // No new requests can enter after the disposable Worker has joined.
      resource.port.close();
      await resource.owner.close();
    }
    lifetime.joined = true;
    send({ type: "stopped", id, code: nativeJoined.code });
  })();
  void lifetime.closing.then(
    () => {
      lifetime.closing = undefined;
    },
    (error: unknown) => {
      lifetime.closing = undefined;
      // Keep the same owner for a later stop retry; a failed close is not a receipt.
      if (error instanceof BrokerNativeResourceCloseError) {
        send({ type: "stop-error", id, error: error.payload, resourceError: true });
      } else {
        send({ type: "stop-error", id, error });
      }
    },
  );
}

function create(request: Extract<NativeWorkerRequest, { type: "create" }>): void {
  const id = request.id;
  const { environment, shareEnvironment, ...options } = request.options;
  const descriptor = request.resource;
  const taskPort = request.taskPort;
  let resourcePorts: MessageChannel | undefined;
  let childData = options.workerData;
  let workerTransfers = request.transferList;
  let worker: Worker;
  try {
    if (descriptor) {
      if (
        (options.workerData !== undefined && !isRecord(options.workerData)) ||
        (isRecord(options.workerData) && descriptor.workerDataKey in options.workerData)
      ) {
        throw new Error("Native resource requires an unused object workerData property");
      }
      resourcePorts = new MessageChannel();
      childData = { ...options.workerData, [descriptor.workerDataKey]: resourcePorts.port2 };
      workerTransfers = [...request.transferList, resourcePorts.port2];
    }
    // The carrier may predate admission; each child inherits the spawning caller's current facts.
    for (const [key, value] of request.environmentData) {
      setEnvironmentData(key, value);
    }
    worker = new Worker(
      request.filename.kind === "url" ? new URL(request.filename.value) : request.filename.value,
      {
        ...options,
        env: shareEnvironment ? SHARE_ENV : environment,
        workerData: childData,
        transferList: workerTransfers,
      },
    );
  } catch (error) {
    resourcePorts?.port1.close();
    resourcePorts?.port2.close();
    taskPort?.close();
    send({ type: "create-error", id, error });
    return;
  }
  const lifetime: NativeLifetime = { worker, joined: false };
  workers.set(id, lifetime);
  try {
    if (resourcePorts && descriptor) {
      const resourcePort = resourcePorts.port1;
      lifetime.resource = {
        port: resourcePort,
        owner: attachBrokerNativeResource(
          descriptor.attachment,
          resourcePort,
          (response) => send({ type: "resource-message", id, response }),
          (error) => {
            send({ type: "error", id, error });
            stop(id, lifetime);
          },
        ),
      };
    }
  } catch (error) {
    taskPort?.close();
    throw error;
  }
  worker.on("message", (value: unknown) => {
    send({ type: "message", id, value }, transfers(value));
  });
  worker.on("messageerror", (error: unknown) => {
    send({ type: "messageerror", id, error });
  });
  worker.on("error", (error) => {
    send({ type: "error", id, error });
    stop(id, lifetime);
  });
  worker.once("exit", (code) => {
    // A child can exit before postMessage transfers its startup endpoint.
    taskPort?.close();
    // Bun finishes its parent-side thread join after delivering the close callback.
    // The next owner turn is after that native stack returns, including natural exit.
    void (async () => {
      await nextTurn();
      lifetime.nativeJoined = { code };
      send({ type: "execution-exit", id, code });
      finishJoined(id, lifetime);
    })().catch((error: unknown) => send({ type: "stop-error", id, error }));
  });
  try {
    send({ type: "created", id, threadId: worker.threadId });
    if (taskPort) {
      worker.postMessage({ type: WORKER_TASK_PORT_MESSAGE, port: taskPort }, [taskPort]);
    }
  } catch (error) {
    taskPort?.close();
    // Construction succeeded: only the real worker/resource join can release custody.
    send({ type: "error", id, error });
    stop(id, lifetime);
  }
}

port.on("message", (message: NativeWorkerRequest) => {
  if (message.type === "create") {
    create(message);
    return;
  }
  const lifetime = workers.get(message.id);
  if (!lifetime) {
    return;
  }
  if (message.type === "release") {
    if (lifetime.joined) {
      lifetime.resource?.owner.dispose();
      workers.delete(message.id);
    }
    return;
  }
  if (message.type === "stop") {
    stop(message.id, lifetime);
    return;
  }
  if (message.type === "resource-owner") {
    lifetime.resource?.owner.ownerMessage(message.value, message.sequence);
    return;
  }
  if (message.type === "ref") {
    if (message.referenced) {
      lifetime.worker.ref();
    } else {
      lifetime.worker.unref();
    }
    return;
  }
  if (message.type === "post") {
    try {
      lifetime.worker.postMessage(message.value, message.transferList);
    } catch (error) {
      send({ type: "messageerror", id: message.id, error });
    }
    return;
  }
  if (message.type === "cpu") {
    const { id, requestId } = message;
    void Promise.resolve()
      .then(() => lifetime.worker.cpuUsage(message.previous))
      .then(
        (value) => send({ type: "cpu", id, requestId, value }),
        (error: unknown) => send({ type: "request-error", id, requestId, error }),
      );
  } else if (message.type === "heap") {
    const { id, requestId } = message;
    void Promise.resolve()
      .then(() => lifetime.worker.getHeapStatistics())
      .then(
        (value) => send({ type: "heap", id, requestId, value }),
        (error: unknown) => send({ type: "request-error", id, requestId, error }),
      );
  }
});
