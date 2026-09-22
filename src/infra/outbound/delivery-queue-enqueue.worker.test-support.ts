import { deserialize } from "node:v8";
import { MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SqliteWorkerRequest } from "../sqlite-worker-contract.js";

/** Intercept the real enqueue reply after SQLite settles, before the host sees it. */
export function holdEnqueueReply() {
  const posted = createDeferredCore();
  const held = createDeferredCore<string>();
  let target: { worker: Worker; requestId: number } | undefined;
  let publish: (() => void) | undefined;
  let captured = false;
  let attempts = 0;
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const nativeOn = vi.spyOn(MessagePort.prototype, "on");
  nativeOn.mockRestore();
  const on = vi.spyOn(MessagePort.prototype, "on");
  Worker.prototype.postMessage = function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (isRecord(command) && command.type === "deliveryQueue.enqueue") {
        target = { worker: this, requestId: request.id };
        attempts += 1;
        posted.resolve();
      }
    }
    return post.call(this, request, transferList);
  };
  on.mockImplementation(function (this: MessagePort, event, listener) {
    if (event !== "message") {
      return nativeOn.call(this, event, listener);
    }
    return nativeOn.call(this, event, function (this: MessagePort, ...args: unknown[]) {
      const message = args[0];
      const reply = isRecord(message) && message.type === "result" ? message.reply : undefined;
      if (
        !captured &&
        target &&
        isRecord(reply) &&
        reply.id === target.requestId &&
        reply.ok === true &&
        reply.value instanceof Uint8Array
      ) {
        const result: unknown = deserialize(reply.value);
        if (typeof result === "string") {
          captured = true;
          publish = () => {
            Reflect.apply(listener, this, args);
          };
          held.resolve(result);
          return;
        }
      }
      Reflect.apply(listener, this, args);
    });
  });
  return {
    posted: posted.promise,
    held: held.promise,
    attempts: () => attempts,
    release() {
      const send = publish;
      publish = undefined;
      send?.();
    },
    async lose() {
      if (!captured || !target) {
        throw new Error("Expected a committed enqueue reply before loss");
      }
      publish = undefined;
      await target.worker.terminate();
    },
    restore() {
      post.mockRestore();
      on.mockRestore();
    },
  };
}
