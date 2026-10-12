import { createServer } from "node:net";
import { serialize } from "node:v8";
import { encodeNativeWorkerFailure } from "../../infra/worker-native-error.js";
import type {
  NativeWorkerResourceModule,
  NativeWorkerResourceOwner,
} from "../../infra/worker-native-lifecycle.types.js";
import { MAX_PENDING_BYTES, MAX_PENDING_MESSAGES } from "./ipc.js";
import { BrokerResourcePort } from "./resource-port.js";
import {
  SPAWN_BROKER_STARTUP_TIMEOUT_MS,
  type BrokerResourceAttachment,
  type BrokerResourceRequest,
  type BrokerResourceResponse,
} from "./resource-protocol.js";
import { createBrokerResourceSocket } from "./resource-socket.js";

type ResourceSocket = ReturnType<typeof createBrokerResourceSocket>;
type ResourceRequest = Exclude<BrokerResourceRequest, { type: "resource-attach" }>;
type Resource = {
  attachment: BrokerResourceAttachment;
  target: BrokerResourcePort;
  ownerPort?: BrokerResourcePort;
  socket?: ResourceSocket;
  initialized: Promise<void>;
  finishInitializationWait?: () => void;
  owner?: NativeWorkerResourceOwner;
  created: boolean;
  targetSealed: boolean;
  closing?: Promise<void>;
  closed: boolean;
  nativeClose?: Promise<void>;
  sequence: number;
  ownerSequence: number;
  ownerMessages: Map<number, { value: unknown; size: number }>;
};

/** The broker retains resource owners independently of their submitting Worker's socket. */
export async function createBrokerNativeResourceServer(options: {
  endpoint: string;
  secret: string;
  generation: number;
  reportParent: (message: BrokerResourceResponse) => Promise<void>;
  canAdmit: () => boolean;
}) {
  const resources = new Map<number, Resource>();
  const connections = new Set<ResourceSocket>();
  let available = true;
  let sourceSealed = false;
  let closePromise: Promise<void> | undefined;
  let ownerBufferedBytes = 0;
  let ownerBufferedMessages = 0;
  const live = () => available && process.connected;
  const publishParent = (message: BrokerResourceResponse) => {
    void options.reportParent(message).catch(() => disconnect());
  };
  const publishSocket = (resource: Resource, message: BrokerResourceResponse) => {
    const socket = resource.socket;
    if (socket) {
      void socket.send(message).catch(() => socket.close());
    }
  };
  const publish = (resource: Resource, message: BrokerResourceResponse) => {
    publishSocket(resource, message);
    publishParent(message);
  };
  const failed = (resource: Resource, error: unknown) => {
    publish(resource, {
      type: "resource-failed",
      id: resource.attachment.id,
      error: encodeNativeWorkerFailure(error),
    });
  };
  const seal = (resource: Resource, ports: Array<BrokerResourcePort | undefined>) => {
    for (const port of ports) {
      try {
        port?.close();
      } catch (error) {
        if (live()) {
          failed(resource, error);
        }
      }
    }
  };
  const closeError = (resource: Resource, requestId: number, error: unknown) => {
    const fields = { type: "resource-close-error", id: resource.attachment.id, requestId } as const;
    let reply: Extract<BrokerResourceResponse, { type: "resource-close-error" }>;
    try {
      if (resource.owner?.encodeCloseError) {
        reply = { ...fields, error: resource.owner.encodeCloseError(error), resourceError: true };
      } else {
        reply = { ...fields, error: encodeNativeWorkerFailure(error), resourceError: false };
      }
    } catch (encodingError) {
      reply = {
        ...fields,
        error: encodeNativeWorkerFailure(
          new AggregateError(
            [error, encodingError],
            "Native resource cleanup error encoding failed",
            {
              cause: error,
            },
          ),
        ),
        resourceError: false,
      };
    }
    publish(resource, reply);
  };
  const closeOwner = (resource: Resource): Promise<void> => {
    if (resource.closed) {
      return Promise.resolve();
    }
    if (resource.nativeClose) {
      return resource.nativeClose;
    }
    const closing = Promise.resolve().then(async () => {
      await resource.owner?.close();
      resource.closed = true;
      seal(resource, [resource.target, resource.ownerPort]);
    });
    resource.nativeClose = closing;
    void closing.catch(() => {
      // Ordinary retained cleanup may retry; terminal retirement joins the same attempt.
      if (available) {
        resource.nativeClose = undefined;
      }
    });
    return closing;
  };
  const closeResource = async (resource: Resource, requestId: number) => {
    if (resource.closed) {
      publish(resource, { type: "resource-closed", id: resource.attachment.id, requestId });
      return;
    }
    try {
      // Both transports join one native close; each request publishes its own receipt.
      await (resource.closing ??= (async () => {
        await new Promise<void>((resolve) => {
          if (sourceSealed) {
            resolve();
            return;
          }
          resource.finishInitializationWait = resolve;
          void resource.initialized.then(resolve);
        });
        if (live()) {
          await closeOwner(resource);
        }
      })().finally(() => {
        resource.closing = undefined;
        resource.finishInitializationWait = undefined;
      }));
      if (live()) {
        publish(resource, { type: "resource-closed", id: resource.attachment.id, requestId });
      }
    } catch (error) {
      if (live()) {
        closeError(resource, requestId, error);
      }
    }
  };
  const receiveOwner = (
    resource: Resource,
    request: Extract<ResourceRequest, { type: "resource-owner" }>,
  ) => {
    if (request.sequence <= resource.ownerSequence) {
      // The original receipt is already queued on both ordered return transports.
      return;
    }
    if (!resource.ownerPort || resource.closed || !resource.created) {
      throw new Error("Native resource owner port is unavailable");
    }
    const ownerPort = resource.ownerPort;
    const apply = (sequence: number, value: unknown) => {
      resource.ownerSequence = sequence;
      try {
        ownerPort.receive(value);
      } catch (error) {
        try {
          publish(resource, {
            type: "resource-owner-rejected",
            id: resource.attachment.id,
            sequence,
            error: encodeNativeWorkerFailure(error),
          });
          return true;
        } catch (receiptError) {
          failed(resource, receiptError);
          disconnect();
          return false;
        }
      }
      publish(resource, { type: "resource-owner-received", id: resource.attachment.id, sequence });
      return true;
    };
    if (request.sequence !== resource.ownerSequence + 1) {
      if (resource.ownerMessages.has(request.sequence)) {
        return;
      }
      const size = serialize(request).length;
      if (
        ownerBufferedBytes + size > MAX_PENDING_BYTES ||
        ownerBufferedMessages >= MAX_PENDING_MESSAGES
      ) {
        throw new Error("Native resource owner receive capacity exceeded");
      }
      resource.ownerMessages.set(request.sequence, { value: request.value, size });
      ownerBufferedBytes += size;
      ownerBufferedMessages++;
      return;
    }
    if (!apply(request.sequence, request.value)) {
      return;
    }
    for (;;) {
      const next = resource.ownerMessages.get(resource.ownerSequence + 1);
      if (!next) {
        return;
      }
      resource.ownerMessages.delete(++resource.ownerSequence);
      ownerBufferedBytes -= next.size;
      ownerBufferedMessages--;
      if (!apply(resource.ownerSequence, next.value)) {
        return;
      }
    }
  };
  const receive = (request: ResourceRequest) => {
    if (!live()) {
      return;
    }
    if (request.type === "resource-seal") {
      // Parent IPC orders this after supervisor join and before cleanup requests.
      // No later attachment or suspended import can introduce a new native owner.
      sourceSealed = true;
      for (const resource of resources.values()) {
        resource.finishInitializationWait?.();
      }
      return;
    }
    if (
      request.type === "resource-close" &&
      (!Number.isSafeInteger(request.requestId) || request.requestId === 0)
    ) {
      publishParent({
        type: "resource-failed",
        id: request.id,
        error: encodeNativeWorkerFailure(new Error("Invalid native resource close request ID")),
      });
      return;
    }
    const resource = resources.get(request.id);
    if (!resource) {
      if (sourceSealed && request.type === "resource-close") {
        // Sealing makes absence final: this ID has no owner and cannot acquire one.
        publishParent({ type: "resource-closed", id: request.id, requestId: request.requestId });
        return;
      }
      publishParent({
        type: "resource-failed",
        id: request.id,
        error: encodeNativeWorkerFailure(new Error("Native resource owner is unavailable")),
      });
      return;
    }
    if (request.type === "resource-owner") {
      try {
        receiveOwner(resource, request);
      } catch (error) {
        failed(resource, error);
      }
    } else if (request.type === "resource-close") {
      void closeResource(resource, request.requestId);
    } else if (request.type === "resource-release") {
      if (!resource.closed) {
        failed(resource, new Error("Native resource must close before release"));
        return;
      }
      resources.delete(request.id);
      for (const pending of resource.ownerMessages.values()) {
        ownerBufferedBytes -= pending.size;
        ownerBufferedMessages--;
      }
      resource.ownerMessages.clear();
      resource.socket?.close();
    } else if (
      !resource.created ||
      resource.closed ||
      ((resource.closing || sourceSealed) && request.type === "resource-target")
    ) {
      failed(resource, new Error("Native resource is not accepting messages"));
    } else {
      try {
        if (resource.targetSealed) {
          throw new Error("Native resource target port is closed");
        }
        resource.target.receive(request.value);
      } catch (error) {
        failed(resource, error);
      }
    }
  };

  const server = createServer((socket) => {
    let attached: Resource | undefined;
    const transport = createBrokerResourceSocket(socket, {
      message(value) {
        if (!live() || !value || typeof value !== "object" || !("type" in value)) {
          transport.close();
          return;
        }
        // SAFETY: The captured secret authenticates this version-matched private peer.
        const request = value as BrokerResourceRequest;
        if (request.type === "resource-seal") {
          // Only the surviving parent, never a submitting Worker, can seal the source.
          transport.close();
          return;
        }
        if (request.type !== "resource-attach") {
          if (
            !attached ||
            request.id !== attached.attachment.id ||
            !["resource-target", "resource-owner", "resource-close", "resource-release"].includes(
              request.type,
            )
          ) {
            transport.close();
            return;
          }
          receive(request);
          return;
        }
        const attachment = request.attachment;
        if (
          sourceSealed ||
          attached ||
          !attachment ||
          attachment.secret !== options.secret ||
          attachment.generation !== options.generation ||
          attachment.endpoint !== options.endpoint ||
          !Number.isSafeInteger(attachment.id) ||
          attachment.id <= 0 ||
          typeof attachment.moduleUrl !== "string" ||
          typeof attachment.ownerPort !== "boolean"
        ) {
          transport.close();
          return;
        }
        // Attachments have one transport lifetime; a lost Worker never reconnects.
        if (resources.has(attachment.id)) {
          transport.close();
          return;
        }
        if (!options.canAdmit()) {
          void transport
            .send({
              type: "resource-failed",
              id: attachment.id,
              error: encodeNativeWorkerFailure(new Error("Spawn broker request capacity exceeded")),
            })
            .finally(() => transport.close())
            .catch(() => {});
          return;
        }
        const current: Resource = {
          attachment,
          target: new BrokerResourcePort((message) => {
            publishSocket(current, {
              type: "resource-target",
              id: attachment.id,
              value: message,
            });
          }),
          initialized: Promise.resolve(),
          created: false,
          targetSealed: false,
          closed: false,
          sequence: 0,
          ownerSequence: 0,
          ownerMessages: new Map(),
        };
        if (attachment.ownerPort) {
          current.ownerPort = new BrokerResourcePort((message) => {
            publish(current, {
              type: "resource-owner",
              id: attachment.id,
              sequence: ++current.sequence,
              value: message,
            });
          });
        }
        resources.set(attachment.id, current);
        attached = current;
        current.socket = transport;
        socket.setTimeout(0);
        const ready: BrokerResourceResponse = {
          type: "resource-ready",
          id: attachment.id,
          pid: process.pid,
          generation: options.generation,
        };
        const readySent = transport.send(ready);
        publishParent(ready);
        current.initialized = (async () => {
          await readySent;
          if (!live() || sourceSealed) {
            return;
          }
          const module: NativeWorkerResourceModule = await import(attachment.moduleUrl);
          if (!live() || sourceSealed) {
            return;
          }
          current.owner = module.createNativeWorkerResource(
            current.target,
            attachment.input,
            current.ownerPort,
          );
          current.created = true;
          publish(current, { type: "resource-created", id: attachment.id });
        })().catch((error: unknown) => {
          failed(current, error);
        });
      },
      close() {
        connections.delete(transport);
        if (attached?.socket === transport) {
          attached.socket = undefined;
          attached.targetSealed = true;
          seal(attached, [attached.target]);
        }
      },
    });
    connections.add(transport);
    socket.setTimeout(SPAWN_BROKER_STARTUP_TIMEOUT_MS, () => transport.close());
    if (!live()) {
      transport.close();
    }
  });
  server.maxConnections = 256;
  const serverClosed = new Promise<void>((resolve) => {
    server.once("close", resolve);
  });
  function disconnect() {
    if (!available) {
      return;
    }
    available = false;
    sourceSealed = true;
    server.close();
    for (const connection of connections) {
      connection.close();
    }
    for (const resource of resources.values()) {
      resource.finishInitializationWait?.();
      seal(resource, [resource.target, resource.ownerPort]);
    }
    // Transport loss revokes admission, not the retained native cleanup obligation.
    void close().catch(() => {
      process.exitCode = 1;
      process.stderr.write("Spawn broker native resource cleanup failed.\n");
    });
  }
  function close(): Promise<void> {
    closePromise ??= Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled(
        [...resources.values()].map(async (resource) => {
          await resource.initialized;
          await closeOwner(resource);
        }),
      );
      await serverClosed;
      const errors = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Spawn broker native resource cleanup failed");
      }
      resources.clear();
    });
    disconnect();
    return closePromise;
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.endpoint, () => {
      server.off("error", reject);
      server.on("error", disconnect);
      resolve();
    });
  });
  return {
    receive,
    disconnect,
    close,
    get size() {
      return resources.size;
    },
  };
}
