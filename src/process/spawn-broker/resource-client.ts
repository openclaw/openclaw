import { connect, type Socket } from "node:net";
import type { MessagePort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { materializeErrorStack } from "../../infra/error-graph-internal.js";
import { decodeNativeWorkerFailure } from "../../infra/worker-native-error.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import {
  BrokerNativeResourceCloseError,
  spawnBrokerStartupNowMs,
  type BrokerResourceAttachment,
  type BrokerResourceRequest,
  type BrokerResourceResponse,
} from "./resource-protocol.js";
import { createBrokerResourceSocket } from "./resource-socket.js";

/** This attachment moves messages; its socket's lifetime is not native resource custody. */
export function attachBrokerNativeResource(
  attachment: BrokerResourceAttachment,
  target: MessagePort,
  observe: (response: BrokerResourceResponse) => void,
  fail: (error: Error) => void,
) {
  const initialized = createDeferredCore();
  void initialized.promise.catch(() => {});
  let transport: ReturnType<typeof createBrokerResourceSocket> | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let closeSequence = 0;
  let ready = false;
  let initializedOwner = false;
  let closed = false;
  let failure: Error | undefined;
  let transportLost = false;
  let closing: { id: number; completion: Deferred } | undefined;
  const recordFailure = (error: Error) => {
    if (closed) {
      return;
    }
    const firstFailure = failure === undefined;
    materializeErrorStack(error);
    failure ??= error;
    clearTimeout(retryTimer);
    clearTimeout(startupTimer);
    initialized.reject(error);
    closing?.completion.reject(error);
    closing = undefined;
    target.close();
    if (firstFailure) {
      fail(error);
    }
  };
  const lose = (error: Error) => {
    if (closed || transportLost) {
      return;
    }
    transportLost = true;
    recordFailure(error);
    transport?.close();
  };
  const transmit = async (message: BrokerResourceRequest, cleanup = false) => {
    if (failure && (!cleanup || transportLost)) {
      throw failure;
    }
    if (!transport || closed) {
      throw new Error("Native resource attachment is closed");
    }
    await transport.send(message);
  };
  const receive = (value: unknown) => {
    if (!isRecord(value) || value.id !== attachment.id || typeof value.type !== "string") {
      lose(new Error("Invalid native resource response identity"));
      return;
    }
    // SAFETY: The authenticated, version-matched spawn owner is the only producer on this socket.
    const response = value as BrokerResourceResponse;
    if (response.type === "resource-target") {
      target.postMessage(response.value, []);
      return;
    }
    observe(response);
    if (response.type === "resource-ready") {
      ready = true;
      clearTimeout(startupTimer);
    } else if (response.type === "resource-created") {
      initializedOwner = true;
      initialized.resolve();
    } else if (response.type === "resource-closed") {
      closed = true;
      clearTimeout(startupTimer);
      closing?.completion.resolve();
      closing = undefined;
      target.close();
      transport?.close();
    } else if (response.type === "resource-close-error") {
      if (closing?.id === response.requestId) {
        const pending = closing;
        closing = undefined;
        pending.completion.reject(
          response.resourceError
            ? new BrokerNativeResourceCloseError(response.error)
            : toErrorObject(
                decodeNativeWorkerFailure(response.error),
                "Native resource close failed",
              ),
        );
      }
    } else if (response.type === "resource-failed") {
      // A failed factory or operation still has a broker-owned close obligation.
      recordFailure(
        toErrorObject(decodeNativeWorkerFailure(response.error), "Native resource failed"),
      );
    }
  };
  const start = () => {
    if (failure || closed) {
      return;
    }
    let candidate: Socket;
    try {
      candidate = connect(attachment.endpoint);
    } catch (error) {
      // An invalid endpoint throws before any socket exists. Report it like an asynchronous
      // connection failure, after the caller has installed this attachment's owner.
      queueMicrotask(() => lose(toErrorObject(error, "Native resource attachment failed")));
      return;
    }
    let connected = false;
    let connectionError: Error | undefined;
    candidate.once("error", (error) => {
      connectionError = error;
    });
    transport = createBrokerResourceSocket(candidate, {
      message: receive,
      close(error) {
        if (closed || transportLost) {
          return;
        }
        if (
          !connected &&
          !ready &&
          attachment.startupDeadline !== undefined &&
          spawnBrokerStartupNowMs() < attachment.startupDeadline
        ) {
          // The same spawn owner's startup deadline bounds a not-yet-listening endpoint.
          retryTimer = setTimeout(start, 10);
          return;
        }
        lose(error ?? connectionError ?? new Error("Native resource attachment lost"));
      },
    });
    candidate.once("connect", () => {
      connected = true;
      void transmit({ type: "resource-attach", attachment }).catch((error: unknown) =>
        lose(toErrorObject(error, "Native resource attachment failed")),
      );
    });
  };
  const startupTimer =
    attachment.startupDeadline === undefined
      ? undefined
      : setTimeout(
          () => {
            if (!ready) {
              lose(new Error("Spawn broker readiness deadline exceeded"));
            }
          },
          Math.max(0, attachment.startupDeadline - spawnBrokerStartupNowMs()),
        );
  start();
  const assertCleanupAvailable = () => {
    if (transportLost && failure) {
      throw failure;
    }
  };
  const failDelivery = (error: unknown, message: string) => {
    const cause = toErrorObject(error, message);
    if (cause !== failure) {
      lose(cause);
    }
  };
  // Keep the target's original port queue until the factory has installed its real receiver.
  void initialized.promise.then(
    () => {
      target.on("message", (value: unknown) => {
        void transmit({ type: "resource-target", id: attachment.id, value }).catch(
          (error: unknown) => failDelivery(error, "Native resource input delivery failed"),
        );
      });
    },
    () => {},
  );
  return {
    ownerMessage(value: unknown, sequence: number) {
      void initialized.promise
        .then(() => transmit({ type: "resource-owner", id: attachment.id, sequence, value }, true))
        .catch((error: unknown) => failDelivery(error, "Native resource owner delivery failed"));
    },
    async close() {
      if (closed) {
        return;
      }
      assertCleanupAvailable();
      if (!initializedOwner) {
        try {
          await initialized.promise;
        } catch (error) {
          if (!ready || transportLost) {
            throw error;
          }
        }
      }
      if (closed) {
        return;
      }
      assertCleanupAvailable();
      const pending = closing ?? { id: ++closeSequence, completion: createDeferredCore() };
      if (!closing) {
        closing = pending;
        void pending.completion.promise.catch(() => {});
        void transmit(
          { type: "resource-close", id: attachment.id, requestId: pending.id },
          true,
        ).catch((error: unknown) =>
          lose(toErrorObject(error, "Native resource close delivery failed")),
        );
      }
      await pending.completion.promise;
    },
    dispose() {
      clearTimeout(retryTimer);
      clearTimeout(startupTimer);
      transport?.close();
    },
  };
}
