import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { vi } from "vitest";
import type { SqliteWorkerReply, SqliteWorkerRequest } from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";

const heldReplies = new Set<() => void>();

export function releaseHeldGitHubPublicationMessages() {
  for (const release of heldReplies) {
    release();
  }
}

export function holdNextReply(
  commandType = "githubPublications.repository",
  beforeDispatch?: () => void,
) {
  const ready = createDeferredCore();
  let deliver: (() => void) | undefined;
  let target: { worker: Worker; id: number } | undefined;
  // Restored spies retain native call-through; Reflect.apply supplies each live Worker.
  const postMessage = vi.spyOn(Worker.prototype, "postMessage");
  postMessage.mockRestore();
  const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    ...args
  ) {
    if (request.type === "execute") {
      const workerCommand: unknown = deserialize(request.input);
      if (
        workerCommand &&
        typeof workerCommand === "object" &&
        "type" in workerCommand &&
        workerCommand.type === commandType
      ) {
        target = { worker: this, id: request.id };
        posts.mockRestore();
        beforeDispatch?.();
      }
    }
    return Reflect.apply(postMessage, this, [request, ...args]);
  });
  const emit = vi.spyOn(Worker.prototype, "emit");
  emit.mockRestore();
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
    ...args
  ) {
    if (event === "message" && this === target?.worker && reply.id === target.id && reply.ok) {
      messages.mockRestore();
      deliver = () => {
        Reflect.apply(emit, this, [event, reply, ...args]);
      };
      ready.resolve();
      return true;
    }
    return Reflect.apply(emit, this, [event, reply, ...args]);
  });
  const release = () => {
    const send = deliver;
    deliver = undefined;
    heldReplies.delete(release);
    try {
      send?.();
    } finally {
      postMessage.mockClear();
      emit.mockClear();
    }
  };
  heldReplies.add(release);
  return { ready: ready.promise, release };
}

export function holdNextReceipt() {
  const ready = createDeferredCore();
  let deliver: (() => void) | undefined;
  const observe = workerAdmission.observeSqliteWorkerCommittedFacts;
  vi.spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts").mockImplementationOnce(
    (admission, observer) => {
      observe(admission, (receipt) => {
        deliver = () => observer(receipt);
        ready.resolve();
      });
    },
  );
  const release = () => {
    const send = deliver;
    deliver = undefined;
    heldReplies.delete(release);
    send?.();
  };
  heldReplies.add(release);
  return { ready: ready.promise, release };
}
