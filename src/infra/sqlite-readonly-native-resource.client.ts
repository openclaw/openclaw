import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { createDeferredCore } from "../shared/deferred.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import type {
  SqliteNativeCommand,
  SqliteNativeOwnerReply,
  SqliteNativeOwnerRequest,
  SqliteNativeCopyLaunch,
  SqliteNativeRequest,
  SqliteNativeReply,
  SqliteNativeSessionLaunch,
  SqliteNativeStagingOptions,
} from "./sqlite-readonly-native-resource.types.js";
import { isSameSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker-session.js";
import type { DatabaseFileIdentity } from "./sqlite-worker-identity.js";
import type { NativeWorkerResourceConnection } from "./worker-native-lifecycle.types.js";

type Result = { ok: true; value?: string } | { ok: false; error: Error };
type SessionState = { retired: boolean; closed: boolean };

/** The target only transports commands; native child custody remains with NativeLifetime. */
export function createSqliteReadOnlyNativeResourceClient(port: MessagePort) {
  const pending = new Map<
    number,
    {
      completion: ReturnType<typeof createDeferredCore<Result>>;
      session?: number;
    }
  >();
  const sessions = new Map<number, SessionState>();
  let sequence = 0;
  let sessionSequence = 0;
  let unavailable: Error | undefined;
  const fail = (cause?: unknown) => {
    unavailable ??= new Error(
      "SQLite native resource transport is unavailable; child cleanup is not acknowledged",
      cause instanceof Error ? { cause } : undefined,
    );
    for (const request of pending.values()) {
      request.completion.reject(unavailable);
    }
    pending.clear();
    return unavailable;
  };
  const receive = (value: SqliteNativeReply) => {
    if (value.type === "session.closed") {
      const session = sessions.get(value.session);
      if (session) {
        session.retired = true;
        session.closed = true;
      }
      return;
    }
    const request = pending.get(value.id);
    if (!request) {
      return;
    }
    pending.delete(value.id);
    const session = request.session === undefined ? undefined : sessions.get(request.session);
    if (session && value.retired !== undefined) {
      session.retired = value.retired;
    }
    if (value.ok) {
      request.completion.resolve({ ok: true, value: value.value });
    } else {
      const error = new Error("SQLite native resource operation failed");
      retainOpenClawStateWorkerErrorPayload(error, value.error);
      request.completion.resolve({
        ok: false,
        error: hydrateOpenClawStateWorkerError(error, { includeOrdinary: true }),
      });
    }
  };
  const drain = () => {
    if (unavailable) {
      return;
    }
    try {
      for (;;) {
        const next = receiveMessageOnPort(port);
        if (!next) {
          return;
        }
        receive(next.message);
      }
    } catch (error) {
      fail(error);
    }
  };
  const send = (message: SqliteNativeRequest) => {
    if (unavailable) {
      throw unavailable;
    }
    try {
      port.postMessage(message);
    } catch (error) {
      throw fail(error);
    }
  };
  const request = (command: SqliteNativeCommand) => {
    drain();
    const id = ++sequence;
    const completion = createDeferredCore<Result>();
    pending.set(id, { completion, session: "session" in command ? command.session : undefined });
    try {
      send({ ...command, id });
    } catch (error) {
      pending.delete(id);
      completion.reject(error);
    }
    return { id, result: completion.promise };
  };
  const unwrap = (result: Result) => {
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  };
  port.on("message", receive);
  port.on("messageerror", fail);
  port.on("close", fail);
  return {
    async removed(directory: string): Promise<void> {
      unwrap(await request({ type: "directory.removed", directory }).result);
    },
    createSession(launch: SqliteNativeSessionLaunch) {
      const captured = {
        ...launch,
        env: { ...launch.env },
        transport: { kind: "native" as const },
      };
      const session = ++sessionSequence;
      const state = { retired: false, closed: false };
      sessions.set(session, state);
      const ready = request({ type: "session.create", session, launch: captured }).result.then(
        unwrap,
      );
      void ready.catch(() => undefined);
      let closing: Promise<void> | undefined;
      let released = false;
      return {
        isRetired() {
          drain();
          return state.retired;
        },
        compatible(other: SqliteNativeSessionLaunch) {
          drain();
          return (
            !unavailable &&
            !closing &&
            !state.retired &&
            isSameSqliteReadOnlyWorkerLaunch(captured, other)
          );
        },
        async run(pathname: string, options: SqliteNativeStagingOptions): Promise<string> {
          await ready;
          if (closing || state.retired) {
            throw new Error("SQLite native session is closed");
          }
          const value = unwrap(
            await request({ type: "session.run", session, pathname, ...options }).result,
          );
          if (typeof value !== "string") {
            throw new Error("SQLite native session returned no location");
          }
          return value;
        },
        close(): Promise<void> {
          if (released) {
            return Promise.resolve();
          }
          return (closing ??= (async () => {
            // A creation refusal still needs the original owner to acknowledge no child remains.
            await ready.catch(() => undefined);
            if (!unavailable || !state.closed) {
              let outcome: Result | undefined;
              try {
                outcome = await request({ type: "session.close", session }).result;
              } catch (error) {
                if (!unavailable || !state.closed) {
                  throw error;
                }
              }
              if (outcome) {
                unwrap(outcome);
              }
            }
            released = true;
            sessions.delete(session);
          })().finally(() => {
            closing = undefined;
          }));
        },
      };
    },
    async runOnce(
      pathname: string,
      options: {
        mode: "sync" | "async";
        stagingRoot?: string;
        signal?: AbortSignal;
        expectedSourceIdentity?: DatabaseFileIdentity;
      },
      launch: SqliteNativeCopyLaunch,
    ): Promise<string> {
      options.signal?.throwIfAborted();
      const call = request({
        type: "copy.run",
        pathname,
        mode: options.mode,
        stagingRoot: options.stagingRoot,
        expectedSourceIdentity: options.expectedSourceIdentity,
        launch: { ...launch, env: { ...launch.env } },
      });
      const abort = () => {
        try {
          send({ type: "copy.cancel", id: call.id });
        } catch {
          /* RPC rejection carries lost custody. */
        }
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
      }
      try {
        const result = await call.result;
        // Only a real operation reply establishes the child-close barrier for cancellation.
        options.signal?.throwIfAborted();
        const value = unwrap(result);
        if (typeof value !== "string") {
          throw new Error("SQLite native copy returned no location");
        }
        return value;
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

/** Host-port framing; the staging owner alone admits readers and retires directories. */
export function createSqliteReadOnlyNativeResourceConnection(callbacks: {
  receive(request: SqliteNativeOwnerRequest, owner: { disposed: boolean }): void;
  onFailure(error: unknown): void;
  onDispose(owner: { disposed: boolean }): void;
}): NativeWorkerResourceConnection {
  const { port1, port2 } = new MessageChannel();
  const owner = { disposed: false };
  const receive = (request: SqliteNativeOwnerRequest) => {
    let reply: SqliteNativeOwnerReply;
    try {
      callbacks.receive(request, owner);
      reply = { id: request.id, ok: true };
    } catch (error) {
      const encoded = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
      if (!encoded) {
        throw error;
      }
      reply = { id: request.id, ok: false, error: encoded };
    }
    port1.postMessage(reply);
  };
  const fail = (error: unknown) => {
    callbacks.onFailure(error);
    port1.close();
  };
  const onMessage = (value: SqliteNativeOwnerRequest) => {
    try {
      receive(value);
    } catch (error) {
      fail(error);
    }
  };
  port1.on("message", onMessage);
  port1.on("messageerror", fail);
  return {
    port: port2,
    service() {
      if (owner.disposed) {
        return;
      }
      for (;;) {
        const next = receiveMessageOnPort(port1);
        if (!next) {
          return;
        }
        try {
          receive(next.message);
        } catch (error) {
          fail(error);
          throw error;
        }
      }
    },
    decodeCloseError(payload: unknown) {
      const remote = new Error("SQLite snapshot staging failed");
      retainOpenClawStateWorkerErrorPayload(remote, payload);
      const error = hydrateOpenClawStateWorkerError(remote, { includeOrdinary: true });
      return error instanceof AggregateError
        ? error
        : new SqliteSnapshotCleanupError(error.message, { cause: error });
    },
    dispose() {
      owner.disposed = true;
      callbacks.onDispose(owner);
      port1.removeAllListeners();
      port1.close();
      port2.close();
    },
  };
}
