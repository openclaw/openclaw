import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { isPrivateDirectoryCreationRefused } from "./private-directory-creation.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "./sqlite-lifecycle-errors.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import {
  closeSqliteSnapshotNativeResources,
  type SqliteNativeSnapshotDirectory,
} from "./sqlite-readonly-native-resource.cleanup.js";
import { readId, readRequest } from "./sqlite-readonly-native-resource.protocol.js";
import type {
  SqliteNativeOwnerRequest,
  SqliteNativeReply,
  SqliteNativeRequest,
  SqliteNativeSessionLaunch,
} from "./sqlite-readonly-native-resource.types.js";
import { SqliteSnapshotAllocationRefusedError } from "./sqlite-readonly-worker-protocol.js";
import {
  createScopedSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerOnce,
} from "./sqlite-readonly-worker.js";
import {
  readSqliteStagingTokenIdentity,
  type SqliteStagingTokenIdentity,
} from "./sqlite-staging-token.js";
import type {
  NativeWorkerResourceOwner,
  NativeWorkerResourcePort,
} from "./worker-native-lifecycle.types.js";

type Session = {
  native?: ReturnType<typeof createScopedSqliteReadOnlyWorker>;
  creationFailure?: unknown;
  token?: TokenDirectory;
  launch: SqliteNativeSessionLaunch;
  running: boolean;
  purpose?: "snapshot" | "token";
  closing?: Promise<void>;
};
type SnapshotDirectory = SqliteNativeSnapshotDirectory<Session>;

type TokenDirectory = {
  kind: "token";
  directory: string;
  preparationId: number;
  sessionId: number;
  session: Session;
  identity: SqliteStagingTokenIdentity;
  mode: "create" | "reclaim";
  unavailable: boolean;
  admitted: boolean;
  sqlDispatched: boolean;
  terminal?: "retired" | "closed" | "not-started";
  receiptAcknowledged?: boolean;
  settlement?: Promise<"retired" | "closed" | "not-started">;
};
type Directory = SnapshotDirectory | TokenDirectory;
type OwnerMessage = SqliteNativeOwnerRequest extends infer Request
  ? Request extends SqliteNativeOwnerRequest
    ? Omit<Request, "id">
    : never
  : never;

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
  const ownerRequests = new Map<
    number,
    ReturnType<typeof createDeferredCore<"retire" | "close" | undefined>>
  >();
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
      if (
        value.disposition !== undefined &&
        value.disposition !== "retire" &&
        value.disposition !== "close"
      ) {
        request.reject(loseOwner());
      } else {
        request.resolve(value.disposition);
      }
    } else {
      const error = new Error("SQLite snapshot host cleanup refused");
      retainOpenClawStateWorkerErrorPayload(error, value.error);
      request.reject(hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }));
    }
  });
  ownerPort.on("close", loseOwner);
  ownerPort.on("messageerror", loseOwner);
  const notify = (message: OwnerMessage) => {
    if (ownerUnavailable) {
      return Promise.reject(ownerUnavailable);
    }
    const id = ++ownerSequence;
    const request = createDeferredCore<"retire" | "close" | undefined>();
    ownerRequests.set(id, request);
    try {
      sendOwnerMessage({ ...message, id });
    } catch (error) {
      loseOwner(error);
    }
    return request.promise;
  };
  const tokenUnavailable = async (directory: string, owned: TokenDirectory) => {
    if (owned.terminal || owned.unavailable) {
      return;
    }
    owned.unavailable = true;
    await notify({ type: "token-unavailable", directory, preparationId: owned.preparationId });
  };
  const announce = async (directory: string, owned: SnapshotDirectory) => {
    if (!owned.announced) {
      await notify({ type: "allocated", directory, preparationId: readId(owned.preparationId) });
      owned.announced = true;
    }
  };
  const removed = async (directory: string) => {
    const owned = directories.get(directory);
    if (!owned || owned.kind !== "snapshot") {
      throw new Error("SQLite snapshot directory is not owned by this native resource");
    }
    owned.removed = true;
    await announce(directory, owned);
    await notify({ type: "removed", directory });
    directories.delete(directory);
  };
  const loseTarget = () => {
    available = false;
  };
  const send = (message: SqliteNativeReply) => {
    if (!available) {
      return;
    }
    try {
      port.postMessage(message);
    } catch {
      loseTarget();
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
      if (session.native) {
        await session.native.close();
        await session.native.closed;
      }
      if (!session.token || session.token.receiptAcknowledged) {
        sessions.delete(id);
      }
    })().finally(() => {
      session.closing = undefined;
    });
    return session.closing;
  };
  const settleToken = (
    directory: string,
    owned: TokenDirectory,
  ): Promise<"retired" | "closed" | "not-started"> => {
    return (owned.settlement ??= (async () => {
      if (owned.terminal) {
        await notify({
          type: "token-settled",
          directory,
          preparationId: owned.preparationId,
          disposition: owned.terminal,
        });
        owned.receiptAcknowledged = true;
        sessions.delete(owned.sessionId);
        return owned.terminal;
      }
      const disposition = await notify({
        type: "token-disposition",
        directory,
        preparationId: owned.preparationId,
      });
      if (disposition !== "retire" && disposition !== "close") {
        throw new Error("SQLite staging token has no owner settlement decision");
      }
      await tokenUnavailable(directory, owned);
      const options = { identity: owned.identity, preparationId: owned.preparationId };
      let committed = false;
      let operationFailure: unknown;
      if (owned.sqlDispatched && owned.session.native && !owned.session.native.isRetired()) {
        try {
          await owned.session.native.run(directory, {
            mode:
              disposition === "close"
                ? "token-close"
                : owned.admitted
                  ? "token-retire"
                  : "token-reconcile",
            ...options,
          });
          committed = disposition === "retire";
        } catch (error) {
          operationFailure = error;
        }
      }
      // Generic tokens have a dedicated child in the existing session owner.
      // Its real join releases Bun's retained handles without revoking sibling roots.
      try {
        await closeSession(owned.sessionId, owned.session);
      } catch (error) {
        if (operationFailure !== undefined) {
          throw createSqliteLifecycleAggregateError(
            [operationFailure, error],
            "SQLite staging token cleanup did not join",
            operationFailure,
          );
        }
        throw error;
      }
      if (owned.sqlDispatched && disposition === "retire" && !committed) {
        // Recovery never restores admission. The original child is joined before
        // a cleanup child uses the captured launch and original inode pair.
        await runSqliteReadOnlyWorkerOnce(
          directory,
          { mode: "token-reconcile", ...options },
          {
            env: owned.session.launch.env,
            cwd: owned.session.launch.cwd,
            deadlineOwnedByCaller: false,
          },
        );
      }
      owned.terminal = !owned.sqlDispatched
        ? "not-started"
        : disposition === "retire"
          ? "retired"
          : "closed";
      await notify({
        type: "token-settled",
        directory,
        preparationId: owned.preparationId,
        disposition: owned.terminal,
      });
      owned.receiptAcknowledged = true;
      sessions.delete(owned.sessionId);
      return owned.terminal;
    })().finally(() => {
      owned.settlement = undefined;
    }));
  };
  async function execute(request: Exclude<SqliteNativeRequest, { type: "copy.cancel" }>) {
    if (
      sealed &&
      request.type !== "session.close" &&
      request.type !== "directory.removed" &&
      request.type !== "token.settle"
    ) {
      throw new Error("SQLite native resource is closing");
    }
    if (request.type === "directory.removed") {
      await removed(request.directory);
      return undefined;
    }
    if (request.type === "token.settle") {
      const owned = sessions.get(request.session)?.token ?? directories.get(request.directory);
      if (
        !owned ||
        owned.kind !== "token" ||
        owned.directory !== request.directory ||
        owned.preparationId !== request.preparationId ||
        owned.sessionId !== request.session
      ) {
        throw new Error("SQLite staging token settlement belongs to another preparation");
      }
      if (owned.session.running) {
        throw new Error("SQLite native session is busy");
      }
      owned.session.running = true;
      try {
        return await settleToken(request.directory, owned);
      } finally {
        owned.session.running = false;
      }
    }
    if (request.type === "session.create") {
      if (sessions.has(request.session)) {
        throw new Error("SQLite native session already exists");
      }
      const session: Session = { launch: request.launch, running: true };
      sessions.set(request.session, session);
      let reservation: TokenDirectory | undefined;
      try {
        if (request.token) {
          session.purpose = "token";
          reservation = {
            kind: "token",
            directory: request.token.directory,
            preparationId: request.token.preparationId,
            sessionId: request.session,
            session,
            identity: request.token.identity,
            mode: request.token.mode,
            unavailable: false,
            admitted: false,
            sqlDispatched: false,
          };
          // The session retains the same record even when directory admission is
          // refused, so its exact never-dispatched preparation can still settle.
          session.token = reservation;
          await notify({ type: "token-reserved", ...request.token });
          const previous = directories.get(request.token.directory);
          if (previous && (previous.kind !== "token" || !previous.receiptAcknowledged)) {
            throw new Error("SQLite staging directory already belongs to this resource");
          }
          if (request.launch.retainLifetime !== false || !request.launch.retainOnOperationError) {
            throw new Error("SQLite staging token session requires independent native custody");
          }
          directories.set(request.token.directory, reservation);
        }
        const native = createScopedSqliteReadOnlyWorker(request.launch);
        session.native = native;
        void native.closed.then(
          () => {
            for (const [directory, owned] of directories) {
              if (owned.kind === "token" && owned.session === session) {
                void tokenUnavailable(directory, owned).catch(() => undefined);
              }
            }
            send({ type: "session.closed", session: request.session });
          },
          () => {},
        );
      } catch (error) {
        session.creationFailure = error;
        if (reservation && request.token) {
          await tokenUnavailable(request.token.directory, reservation);
        }
        throw error;
      } finally {
        session.running = false;
      }
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
        for (const [directory, owned] of directories) {
          if (owned.kind === "token" && owned.sessionId === request.session) {
            await settleToken(directory, owned);
          }
        }
        return undefined;
      }
      throw new Error("SQLite native session is closed");
    }
    if (request.type === "session.close") {
      if (session.running) {
        throw new Error("SQLite native session is busy");
      }
      session.running = true;
      try {
        if (session.token) {
          await settleToken(session.token.directory, session.token);
        }
        await closeSession(request.session, session);
        return undefined;
      } finally {
        session.running = false;
      }
    }
    if (session.running || session.closing) {
      throw new Error("SQLite native session is busy");
    }
    if (
      session.native?.isRetired() &&
      request.mode !== "token-create" &&
      request.mode !== "token-reclaim"
    ) {
      throw new Error("SQLite native session is closed");
    }
    session.running = true;
    try {
      if (request.mode === "token-create" || request.mode === "token-reclaim") {
        const owned = directories.get(request.pathname);
        if (
          !owned ||
          owned.kind !== "token" ||
          owned.session !== session ||
          owned.preparationId !== request.preparationId ||
          owned.mode !== (request.mode === "token-create" ? "create" : "reclaim") ||
          JSON.stringify(owned.identity) !== JSON.stringify(request.identity) ||
          owned.sqlDispatched
        ) {
          throw new Error("SQLite staging token does not match its original reservation");
        }
        try {
          if (!session.native) {
            throwSqliteLifecycleErrors(
              [session.creationFailure ?? new Error("SQLite native session did not start")],
              "SQLite native session did not start",
            );
          }
          if (owned.unavailable || session.native.isRetired()) {
            throw new Error("SQLite staging token lost its original native owner");
          }
          owned.sqlDispatched = true;
          const result = readSqliteStagingTokenIdentity(
            await session.native.run(request.pathname, {
              mode: request.mode,
              identity: owned.identity,
              preparationId: owned.preparationId,
            }),
          );
          if (JSON.stringify(result) !== JSON.stringify(owned.identity)) {
            throw new Error("SQLite staging token native identity changed");
          }
          owned.admitted = true;
          await notify({
            type: "token-admitted",
            directory: request.pathname,
            preparationId: owned.preparationId,
          });
          if (owned.unavailable) {
            throw new Error("SQLite staging token lost its original native owner");
          }
          return result;
        } catch (error) {
          await tokenUnavailable(request.pathname, owned);
          throw error;
        }
      }
      if (session.purpose === "token") {
        throw new Error("SQLite staging token session cannot allocate snapshots");
      }
      session.purpose = "snapshot";
      if (!session.native) {
        throwSqliteLifecycleErrors(
          [session.creationFailure ?? new Error("SQLite native session did not start")],
          "SQLite native session did not start",
        );
      }
      const native = session.native;
      const allocating =
        request.mode === "staging-create" || request.mode === "staging-create-legacy";
      let result: Awaited<ReturnType<typeof native.run>>;
      try {
        result = await native.run(request.pathname, { mode: request.mode });
        if (
          allocating &&
          (typeof result !== "string" || result.length === 0 || result.includes("\0"))
        ) {
          throw new Error("SQLite native allocation returned no exact directory");
        }
      } catch (error) {
        // Validation, missing sessions and factory refusal never enter this dispatched boundary.
        if (
          allocating &&
          !native.notStarted &&
          !(error instanceof SqliteSnapshotAllocationRefusedError) &&
          !isPrivateDirectoryCreationRefused(error)
        ) {
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
        const owned: SnapshotDirectory = {
          kind: "snapshot",
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
        loseTarget();
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
        const replyValue =
          result === undefined || typeof result === "string"
            ? result
            : readSqliteStagingTokenIdentity(result);
        send({
          type: "result",
          id: command.id,
          ok: true,
          value: replyValue,
          retired:
            command.type === "session.close"
              ? true
              : "session" in command
                ? sessions.get(command.session)?.native?.isRetired()
                : undefined,
        });
      })
      .catch((error: unknown) => {
        fail(
          command.id,
          error,
          "session" in command ? sessions.get(command.session)?.native?.isRetired() : undefined,
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
  port.on("close", loseTarget);
  port.on("messageerror", () => {
    loseTarget();
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
        const tokenFailures: unknown[] = [];
        // Each settlement joins its dedicated child before publishing its receipt.
        for (const session of sessions.values()) {
          if (!session.token) {
            continue;
          }
          try {
            await settleToken(session.token.directory, session.token);
          } catch (error) {
            tokenFailures.push(error);
          }
        }
        await closeSqliteSnapshotNativeResources({
          directories,
          // Failed token settlement retains its dedicated session and creator lock.
          sessions: [...sessions].filter(([, session]) => !session.token),
          announce,
          requestRetirement: (directory) => notify({ type: "retire", directory }),
          closeSession,
          removed,
          tokenFailures,
          uncertainAllocations,
        });
        port.off("message", receive);
        port.close();
        ownerPort.close();
      })().finally(() => {
        closing = undefined;
      }));
    },
  };
}
