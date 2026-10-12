import { connect } from "node:net";
import type { MessagePort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  let closing: { id: number; completion: Deferred } | undefined;
  const lose = (error: Error) => {
    if (closed || failure) {
      return;
    }
    failure = error;
    clearTimeout(retryTimer);
    clearTimeout(startupTimer);
    initialized.reject(error);
    closing?.completion.reject(error);
    closing = undefined;
    target.close();
    transport?.close();
    fail(error);
  };
  const transmit = async (message: BrokerResourceRequest) => {
    if (failure) {
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
      lose(toErrorObject(decodeNativeWorkerFailure(response.error), "Native resource failed"));
    }
  };
  const start = () => {
    if (failure || closed) {
      return;
    }
    const candidate = connect(attachment.endpoint);
    let connected = false;
    let connectionError: Error | undefined;
    candidate.once("error", (error) => {
      connectionError = error;
    });
    transport = createBrokerResourceSocket(candidate, {
      message: receive,
      close(error) {
        if (closed || failure) {
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
  const assertAvailable = () => {
    if (failure) {
      throw failure;
    }
  };
  // Collect target input from the first tick. A listener attached only after the factory
  // admits ownership depends on the port still holding its queue, which any other consumer
  // of this port, or an explicit start(), drains first.
  const admitTarget = (value: unknown) => {
    void transmit({ type: "resource-target", id: attachment.id, value }).catch((error: unknown) =>
      lose(toErrorObject(error, "Native resource input delivery failed")),
    );
  };
  const deferredTargetInput: unknown[] = [];
  let admittingTarget = false;
  target.on("message", (value: unknown) => {
    if (!admittingTarget) {
      deferredTargetInput.push(value);
      return;
    }
    admitTarget(value);
  });
  void initialized.promise.then(
    () => {
      admittingTarget = true;
      for (const value of deferredTargetInput.splice(0)) {
        admitTarget(value);
      }
    },
    () => {},
  );
  return {
    ownerMessage(value: unknown, sequence: number) {
      void initialized.promise
        .then(() => transmit({ type: "resource-owner", id: attachment.id, sequence, value }))
        .catch((error: unknown) =>
          lose(toErrorObject(error, "Native resource owner delivery failed")),
        );
    },
    async close() {
      if (closed) {
        return;
      }
      assertAvailable();
      if (!initializedOwner) {
        await initialized.promise;
      }
      if (closed) {
        return;
      }
      assertAvailable();
      const pending = closing ?? { id: ++closeSequence, completion: createDeferredCore() };
      if (!closing) {
        closing = pending;
        void pending.completion.promise.catch(() => {});
        void transmit({ type: "resource-close", id: attachment.id, requestId: pending.id }).catch(
          (error: unknown) => lose(toErrorObject(error, "Native resource close delivery failed")),
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
