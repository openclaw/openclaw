import fs from "node:fs/promises";
import { createDeferredCore } from "../shared/deferred.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import type {
  SqliteNativeOwnerRequest,
  SqliteNativeOwnerReply,
  SqliteNativeReply,
  SqliteNativeRequest,
  SqliteNativeSessionLaunch,
} from "./sqlite-readonly-native-resource.types.js";
import {
  createScopedSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerOnce,
} from "./sqlite-readonly-worker.js";
import type {
  NativeWorkerResourceOwner,
  NativeWorkerResourcePort,
} from "./worker-native-lifecycle.types.js";

type Session = {
  native: ReturnType<typeof createScopedSqliteReadOnlyWorker>;
  launch: SqliteNativeSessionLaunch;
  running: boolean;
  closing?: Promise<void>;
};
type Directory = {
  preparationId: number;
  session: Session;
  announced: boolean;
  removed: boolean;
};

/** NativeLifetime installs this owner before delivering the port to its target Worker. */
export function createNativeWorkerResource(
  port: NativeWorkerResourcePort,
  input: unknown,
  ownerPort?: NativeWorkerResourcePort,
): NativeWorkerResourceOwner {
  if (input !== undefined) {
    throw new Error("SQLite native resource does not accept bootstrap input");
  }
  if (!ownerPort) {
    throw new Error("SQLite native resource requires its host cleanup owner");
  }
  const sendOwnerMessage = ownerPort.postMessage.bind(ownerPort);
  const sessions = new Map<number, Session>();
  const directories = new Map<string, Directory>();
  const copies = new Map<number, AbortController>();
  const active = new Set<Promise<void>>();
  const ownerRequests = new Map<number, ReturnType<typeof createDeferredCore<void>>>();
  let ownerSequence = 0;
  let ownerUnavailable: SqliteSnapshotCleanupError | undefined;
  let sealed = false;
  let available = true;
  let closing: Promise<void> | undefined;
  const loseOwner = (cause?: unknown) => {
    ownerUnavailable ??= new SqliteSnapshotCleanupError(
      "SQLite snapshot host cleanup owner is unavailable; directory removal is not acknowledged",
      cause instanceof Error ? { cause } : undefined,
    );
    for (const request of ownerRequests.values()) {
      request.reject(ownerUnavailable);
    }
    ownerRequests.clear();
    return ownerUnavailable;
  };
  ownerPort.on("message", (message) => {
    // SAFETY: The typed host connection is the only producer of cleanup replies.
    const value = message as SqliteNativeOwnerReply;
    const request = ownerRequests.get(value.id);
    if (!request) {
      return;
    }
    ownerRequests.delete(value.id);
    if (value.ok) {
      request.resolve();
    } else {
      const error = new Error("SQLite snapshot host cleanup refused");
      retainOpenClawStateWorkerErrorPayload(error, value.error);
      request.reject(hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }));
    }
  });
  ownerPort.on("close", loseOwner);
  ownerPort.on("messageerror", loseOwner);
  const notifyOwner = (
    type: SqliteNativeOwnerRequest["type"],
    directory: string,
    preparationId?: number,
  ) => {
    if (ownerUnavailable) {
      return Promise.reject(ownerUnavailable);
    }
    const id = ++ownerSequence;
    const request = createDeferredCore();
    ownerRequests.set(id, request);
    try {
      const message: SqliteNativeOwnerRequest =
        type === "allocated"
          ? { id, type, directory, preparationId: preparationId! }
          : { id, type, directory };
      sendOwnerMessage(message);
    } catch (error) {
      loseOwner(error);
    }
    return request.promise;
  };
  const announce = async (directory: string, owned: Directory) => {
    if (!owned.announced) {
      await notifyOwner("allocated", directory, owned.preparationId);
      owned.announced = true;
    }
  };
  const removed = async (directory: string) => {
    const owned = directories.get(directory);
    if (!owned) {
      throw new Error("SQLite snapshot directory is not owned by this native resource");
    }
    owned.removed = true;
    await announce(directory, owned);
    await notifyOwner("removed", directory);
    directories.delete(directory);
  };
  const send = (message: SqliteNativeReply) => {
    if (!available) {
      return;
    }
    try {
      port.postMessage(message);
    } catch {
      available = false;
    }
  };
  const fail = (id: number, error: unknown, retired?: boolean) => {
    const encoded =
      encodeOpenClawStateWorkerError(error, { includeOrdinary: true }) ??
      encodeOpenClawStateWorkerError(new Error("SQLite native resource operation failed"), {
        includeOrdinary: true,
      });
    if (encoded) {
      send({ type: "result", id, ok: false, error: encoded, retired });
    }
  };
  const closeSession = (id: number, session: Session): Promise<void> => {
    session.closing ??= (async () => {
      await session.native.close();
      await session.native.closed;
      sessions.delete(id);
    })().finally(() => {
      session.closing = undefined;
    });
    return session.closing;
  };
  async function execute(request: Exclude<SqliteNativeRequest, { type: "copy.cancel" }>) {
    if (sealed && request.type !== "session.close" && request.type !== "directory.removed") {
      throw new Error("SQLite native resource is closing");
    }
    if (request.type === "directory.removed") {
      await removed(request.directory);
      return undefined;
    }
    if (request.type === "session.create") {
      if (sessions.has(request.session)) {
        throw new Error("SQLite native session already exists");
      }
      const native = createScopedSqliteReadOnlyWorker(request.launch);
      sessions.set(request.session, { native, launch: request.launch, running: false });
      void native.closed.then(
        () => send({ type: "session.closed", session: request.session }),
        () => {},
      );
      return undefined;
    }
    if (request.type === "copy.run") {
      const controller = copies.get(request.id);
      if (!controller) {
        throw new Error("SQLite native copy lost its admission");
      }
      controller.signal.throwIfAborted();
      return await runSqliteReadOnlyWorkerOnce(
        request.pathname,
        {
          mode: request.mode,
          stagingRoot: request.stagingRoot,
          expectedSourceIdentity: request.expectedSourceIdentity,
          signal: controller.signal,
        },
        request.launch,
      );
    }
    const session = sessions.get(request.session);
    if (!session) {
      if (request.type === "session.close") {
        return undefined;
      }
      throw new Error("SQLite native session is closed");
    }
    if (request.type === "session.close") {
      await closeSession(request.session, session);
      return undefined;
    }
    if (session.running || session.closing) {
      throw new Error("SQLite native session is busy");
    }
    if (session.native.isRetired()) {
      throw new Error("SQLite native session is closed");
    }
    session.running = true;
    try {
      const allocating =
        request.mode === "staging-create" || request.mode === "staging-create-legacy";
      // A failed allocation can leak an unreported temp directory, but must not poison shutdown.
      const result = await session.native.run(request.pathname, { mode: request.mode });
      if (allocating && typeof result === "string") {
        const owned = {
          preparationId: request.preparationId,
          session,
          announced: false,
          removed: false,
        };
        directories.set(result, owned);
        // The surviving host must know this original path before the target can publish it.
        await announce(result, owned);
      }
      return result;
    } finally {
      session.running = false;
    }
  }
  const receive = (message: unknown) => {
    // SAFETY: This private port has one typed sender; native child I/O is validated separately.
    const request = message as SqliteNativeRequest;
    if (request.type === "copy.cancel") {
      copies.get(request.id)?.abort(new Error("SQLite native copy cancelled"));
      return;
    }
    const command = request;
    if (command.type === "copy.run") {
      if (copies.has(command.id)) {
        fail(command.id, new Error("SQLite native copy already exists"));
        return;
      }
      copies.set(command.id, new AbortController());
    }
    const work = Promise.resolve()
      .then(() => execute(command))
      .then((result) => {
        if (result !== undefined && typeof result !== "string") {
          throw new Error("SQLite native resource returned an invalid location");
        }
        send({
          type: "result",
          id: command.id,
          ok: true,
          value: result,
          retired:
            command.type === "session.close"
              ? true
              : "session" in command
                ? sessions.get(command.session)?.native.isRetired()
                : undefined,
        });
      })
      .catch((error: unknown) => {
        fail(
          command.id,
          error,
          "session" in command ? sessions.get(command.session)?.native.isRetired() : undefined,
        );
      })
      .finally(() => {
        if (command.type === "copy.run") {
          copies.delete(command.id);
        }
        active.delete(work);
      });
    active.add(work);
  };
  port.on("message", receive);
  port.on("close", () => {
    available = false;
  });
  port.on("messageerror", () => {
    available = false;
    port.close();
  });
  return {
    encodeCloseError: (error: unknown) =>
      encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
    close() {
      sealed = true;
      return (closing ??= (async () => {
        for (const controller of copies.values()) {
          controller.abort(new Error("SQLite native resource closed"));
        }
        // Session.close marks the connection retired and ignores late replies: collect
        // accepted allocation facts first, under their original native operation budget.
        await Promise.allSettled(active);
        const fences = await Promise.allSettled(
          [...directories].map(async ([directory, owned]) => {
            await announce(directory, owned);
            if (!owned.removed) {
              await notifyOwner("retire", directory);
            }
          }),
        );
        // Keep creator locks alive when a host reader has not acquired its disk token yet.
        throwSqliteLifecycleErrors(
          fences.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
          "SQLite snapshot host cleanup admission failed",
        );
        const outcomes = await Promise.allSettled(
          [...sessions].map(([id, session]) => closeSession(id, session)),
        );
        throwSqliteLifecycleErrors(
          outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
          "SQLite native resource cleanup failed",
        );
        const failures: unknown[] = [];
        for (const [directory, owned] of directories) {
          try {
            if (!owned.removed) {
              await runSqliteReadOnlyWorkerOnce(
                directory,
                { mode: "staging-reconcile" },
                {
                  env: owned.session.launch.env,
                  cwd: owned.session.launch.cwd,
                  deadlineOwnedByCaller: false,
                },
              );
              await fs.rm(directory, {
                force: true,
                recursive: true,
                maxRetries: 3,
                retryDelay: 20,
              });
            }
            await removed(directory);
          } catch (error) {
            failures.push(error);
          }
        }
        throwSqliteLifecycleErrors(failures, "SQLite snapshot native directory cleanup failed");
        port.off("message", receive);
        port.close();
        ownerPort.close();
      })().finally(() => {
        closing = undefined;
      }));
    },
  };
}
