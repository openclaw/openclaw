import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SqliteWorkerRequest } from "../sqlite-worker-contract.js";

/** Hold one exact committed ACK response without changing its database operation. */
export function holdAcknowledgementReply(id: string) {
  const posted = createDeferredCore();
  const held = createDeferredCore<string[]>();
  let target: { worker: Worker; requestId: number } | undefined;
  let publish: (() => void) | undefined;
  let captured = false;
  let attempts = 0;
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const emit = vi.spyOn(Worker.prototype, "emit");
  Worker.prototype.postMessage = function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (
        isRecord(command) &&
        command.type === "deliveryQueue.ack" &&
        isRecord(command.input) &&
        command.input.id === id
      ) {
        target = { worker: this, requestId: request.id };
        attempts += 1;
        posted.resolve();
      }
    }
    return post.call(this, request, transferList);
  };
  Worker.prototype.emit = function (this: Worker, event: string | symbol, ...args: unknown[]) {
    const reply = args[0];
    if (
      !captured &&
      target?.worker === this &&
      event === "message" &&
      isRecord(reply) &&
      reply.id === target.requestId &&
      reply.ok === true &&
      reply.value instanceof Uint8Array
    ) {
      const result: unknown = deserialize(reply.value);
      if (
        Array.isArray(result) &&
        result.every((entry): entry is string => typeof entry === "string")
      ) {
        captured = true;
        publish = () => {
          Reflect.apply(emit, this, [event, ...args]);
        };
        held.resolve(result);
        return true;
      }
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  return {
    posted: posted.promise,
    held: held.promise,
    attempts: () => attempts,
    release: () => {
      const send = publish;
      publish = undefined;
      send?.();
    },
    lose: async () => {
      if (!captured || !target) {
        throw new Error("Expected a committed ACK reply before loss");
      }
      publish = undefined;
      await target.worker.terminate();
    },
    restore: () => {
      post.mockRestore();
      emit.mockRestore();
    },
  };
}
