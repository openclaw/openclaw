import { receiveMessageOnPort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import {
  BrokerNativeResourceCloseError,
  type BrokerResourceResponse,
} from "../process/spawn-broker/resource-protocol.js";
import type {
  NativeWorkerResourceConnection,
  NativeWorkerResourceDescriptor,
} from "./worker-native-lifecycle.types.js";

/** Binds the host's original cleanup port to the same surviving spawn-owner claim. */
export function bindNativeWorkerResource(options: {
  broker: SpawnBrokerHost;
  descriptor: NativeWorkerResourceDescriptor;
  connection?: NativeWorkerResourceConnection;
  supervisorAvailable(): boolean;
  postOwnerMessage(value: unknown, sequence: number): void;
  closed(): void;
  failed(error: Error): void;
}) {
  const { broker, descriptor, connection } = options;
  let disposed = false;
  const lease = broker.captureNativeResource(
    { moduleUrl: descriptor.moduleUrl, input: descriptor.input, ownerPort: Boolean(connection) },
    {
      message(response) {
        if (response.type === "resource-owner") {
          connection?.port.postMessage(response.value, []);
        } else if (response.type === "resource-closed") {
          options.closed();
        }
      },
      failed: (error) => options.failed(error),
    },
  );
  const forward = (value: unknown) => {
    if (disposed) {
      return;
    }
    try {
      // The surviving claim retains the original reply even if the primary relay dies.
      const delivery = lease.ownerMessage(value);
      if (options.supervisorAvailable()) {
        options.postOwnerMessage(value, delivery.sequence);
      }
    } catch (error) {
      options.failed(toErrorObject(error, "Native resource owner delivery failed"));
    }
  };
  connection?.port.on("message", forward);
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    connection?.port.off("message", forward);
    connection?.port.close();
    connection?.dispose();
  };
  return {
    attachment: lease.attachment,
    receive(response: BrokerResourceResponse) {
      lease.receive(response);
    },
    service() {
      if (disposed || !connection) {
        return;
      }
      connection.service();
      for (;;) {
        const next = receiveMessageOnPort(connection.port);
        if (!next) {
          break;
        }
        forward(next.message);
      }
    },
    async closeAfterSupervisor() {
      try {
        await broker.sealNativeResources();
        await lease.close();
      } catch (error) {
        if (error instanceof BrokerNativeResourceCloseError && connection?.decodeCloseError) {
          throw connection.decodeCloseError(error.payload);
        }
        throw error;
      }
    },
    release() {
      lease.release();
      dispose();
    },
    abandonUnattached() {
      lease.abandonUnattached();
      dispose();
    },
  };
}
