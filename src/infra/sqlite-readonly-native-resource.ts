import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  SqliteNativeReply,
  SqliteNativeRequest,
  SqliteNativeSessionLaunch,
} from "./sqlite-readonly-native-resource.types.js";
import {
  createScopedSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerOnce,
} from "./sqlite-readonly-worker.js";
import { readDatabaseFileIdentity } from "./sqlite-worker-identity.js";
import type {
  NativeWorkerResourceOwner,
  NativeWorkerResourcePort,
} from "./worker-native-lifecycle.types.js";

function readId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("SQLite native resource requires a positive request identity");
  }
  return value;
}
function readPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error("SQLite native resource requires a filesystem path");
  }
  return value;
}
function readLaunch(value: unknown): Pick<SqliteNativeSessionLaunch, "env" | "cwd"> {
  if (!isRecord(value) || !isRecord(value.env)) {
    throw new Error("SQLite native resource requires captured launch facts");
  }
  const entries: Array<[string, string | undefined]> = [];
  for (const [key, item] of Object.entries(value.env)) {
    if (
      !key ||
      key.includes("=") ||
      key.includes("\0") ||
      (item !== undefined && (typeof item !== "string" || item.includes("\0")))
    ) {
      throw new Error("SQLite native resource received an invalid environment");
    }
    entries.push([key, item]);
  }
  return { env: Object.fromEntries(entries), cwd: readPath(value.cwd) };
}
function readRequest(value: unknown): SqliteNativeRequest {
  if (!isRecord(value)) {
    throw new Error("SQLite native resource requires a command");
  }
  const id = readId(value.id);
  if (value.type === "copy.cancel") {
    return { type: value.type, id };
  }
  if (value.type === "directory.removed") {
    return { type: value.type, id, directory: readPath(value.directory) };
  }
  if (value.type === "session.close") {
    return { type: value.type, id, session: readId(value.session) };
  }
  if (
    value.type === "session.run" &&
    (value.mode === "staging-create" ||
      value.mode === "staging-create-legacy" ||
      value.mode === "staging-retire" ||
      value.mode === "staging-reconcile")
  ) {
    return {
      type: value.type,
      id,
      session: readId(value.session),
      pathname: readPath(value.pathname),
      ...(value.mode === "staging-create" || value.mode === "staging-create-legacy"
        ? { mode: value.mode, preparationId: readId(value.preparationId) }
        : { mode: value.mode }),
    };
  }
  if (
    value.type === "session.create" &&
    isRecord(value.launch) &&
    isRecord(value.launch.transport) &&
    value.launch.transport.kind === "native" &&
    (value.launch.retainLifetime === undefined ||
      typeof value.launch.retainLifetime === "boolean") &&
    (value.launch.retainOnOperationError === undefined ||
      typeof value.launch.retainOnOperationError === "boolean")
  ) {
    return {
      type: value.type,
      id,
      session: readId(value.session),
      launch: {
        ...readLaunch(value.launch),
        transport: { kind: "native" },
        retainLifetime: value.launch.retainLifetime,
        retainOnOperationError: value.launch.retainOnOperationError,
      },
    };
  }
  if (
    value.type === "copy.run" &&
    (value.mode === "sync" || value.mode === "async") &&
    isRecord(value.launch) &&
    typeof value.launch.deadlineOwnedByCaller === "boolean"
  ) {
    const expectedSourceIdentity =
      value.expectedSourceIdentity === undefined
        ? undefined
        : readDatabaseFileIdentity(value.expectedSourceIdentity);
    if (expectedSourceIdentity && value.mode !== "sync") {
      throw new Error("SQLite source identity requires artifact-preserving preparation");
    }
    return {
      type: value.type,
      id,
      pathname: readPath(value.pathname),
      mode: value.mode,
      stagingRoot: value.stagingRoot === undefined ? undefined : readPath(value.stagingRoot),
      expectedSourceIdentity,
      launch: {
        ...readLaunch(value.launch),
        deadlineOwnedByCaller: value.launch.deadlineOwnedByCaller,
      },
    };
  }
  throw new Error("SQLite native resource received an unsupported command");
}

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
  const uncertainAllocations: SqliteSnapshotCleanupError[] = [];
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
  ownerPort.on("message", (value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      (value.ok !== true && value.ok !== false)
    ) {
      loseOwner();
      return;
    }
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
          ? { id, type, directory, preparationId: readId(preparationId) }
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
      let result: Awaited<ReturnType<typeof session.native.run>>;
      try {
        result = await session.native.run(request.pathname, { mode: request.mode });
        if (
          allocating &&
          (typeof result !== "string" || result.length === 0 || result.includes("\0"))
        ) {
          throw new Error("SQLite native allocation returned no exact directory");
        }
      } catch (error) {
        // Validation, missing sessions and factory refusal never enter this dispatched boundary.
        if (allocating && !session.native.notStarted) {
          uncertainAllocations.push(
            new SqliteSnapshotCleanupError(
              "SQLite snapshot allocation has no exact directory receipt; cleanup is unresolved",
              { cause: error },
            ),
          );
        }
        throw error;
      }
      if (
        (request.mode === "staging-create" || request.mode === "staging-create-legacy") &&
        typeof result === "string"
      ) {
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
  const receive = (value: unknown) => {
    let request: SqliteNativeRequest;
    try {
      request = readRequest(value);
    } catch (error) {
      if (
        isRecord(value) &&
        typeof value.id === "number" &&
        Number.isSafeInteger(value.id) &&
        value.id > 0
      ) {
        fail(value.id, error);
      } else {
        available = false;
        port.close();
      }
      return;
    }
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
        const failures: unknown[] = [...uncertainAllocations];
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
