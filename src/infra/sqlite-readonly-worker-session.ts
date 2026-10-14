import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Socket } from "node:net";
import path from "node:path";
import { serialize } from "node:v8";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { BrokerChild } from "../process/spawn-broker/child.js";
import { recordChildProcessSpawn } from "../process/spawn-diagnostics.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../state/openclaw-agent-db-resources.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { getSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { tryProcessCwd } from "./safe-cwd.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import { captureSqliteAuthSchema } from "./sqlite-readonly-auth-schema.js";
import {
  createSqliteAuthTransferReceiver,
  createSqliteOperationTransferReceiver,
} from "./sqlite-readonly-auth-transfer.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import {
  readOnlyWorkerScope,
  type SqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker-context.js";
import {
  createSqliteReadOnlyWorkerError,
  isSqliteReadOnlyWorkerResult,
  isSqliteSnapshotStagingMode,
  readSqliteReadOnlyWorkerValue,
  SQLITE_READONLY_STDERR_TAIL_CHARS,
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  type SqliteReadOnlyWorkerMode,
  type SqliteAuthProfileReadOptions,
  type SqliteReadOnlyOperationOptions,
  type SqliteReadOnlyWorkerOptions,
  type SqliteReadOnlyWorkerValue,
} from "./sqlite-readonly-worker-protocol.js";
import type {
  SqliteReadOnlyWorkerLaunch,
  SqliteReadOnlyWorkerSession,
} from "./sqlite-readonly-worker-session-types.js";
import { classifyWorkerRequest, trackWorkerRequest } from "./worker-request-diagnostics.js";

export function isSameSqliteReadOnlyWorkerLaunch(
  captured: SqliteReadOnlyWorkerLaunch,
  requested: SqliteReadOnlyWorkerLaunch,
): boolean {
  const keys = Object.keys(requested.env);
  return (
    captured.runtimeGeneration === requested.runtimeGeneration &&
    captured.transport.kind === requested.transport.kind &&
    (captured.transport.kind === "native" ||
      (requested.transport.kind === "broker" &&
        captured.transport.owner === requested.transport.owner)) &&
    requested.cwd === captured.cwd &&
    keys.length === Object.keys(captured.env).length &&
    keys.every((key) => requested.env[key] === captured.env[key])
  );
}

export function createSqliteReadOnlyWorkerSession(
  host: SqliteReadOnlyWorkerLaunch & {
    retainLifetime?: boolean;
    retainOnOperationError?: boolean;
    pooledRead?: boolean;
    argv: string[];
    requestArgs: (pathname: string, options: SqliteReadOnlyWorkerOptions) => string[];
    readBudget: (pathname: string) => { timeoutMs: number; size: string };
    deadlineOwnedByCaller: () => boolean;
    timeoutError: (pathname: string, timeoutMs: number, size: string) => Error;
    closeTimeoutMs: number;
  },
): SqliteReadOnlyWorkerSession {
  const env = { ...host.env };
  const cwd = host.cwd;
  const executable = process.execPath;
  const transport: SqliteReadOnlyWorkerLaunch["transport"] =
    host.transport.kind === "broker"
      ? { kind: "broker", owner: host.transport.owner }
      : { kind: "native" };
  const capturedLaunch = { env, cwd, transport, runtimeGeneration: host.runtimeGeneration };
  const argv = [...host.argv];
  const spawnOptions: SpawnOptions = {
    env,
    // Inheriting the current directory avoids a redundant chdir that can fail under sudo -u.
    ...(transport.kind === "native" && cwd === tryProcessCwd() ? {} : { cwd }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  };
  const child: ChildProcess =
    transport.kind === "broker"
      ? transport.owner.spawn(executable, argv, spawnOptions)
      : spawn(executable, argv, spawnOptions);
  recordChildProcessSpawn(
    executable,
    child,
    host.pooledRead ? `sqlite.scoped-read.${transport.kind}` : `sqlite.session.${transport.kind}`,
  );
  const setIdle = (idle: boolean) => {
    if (transport.kind !== "native") {
      return;
    }
    const method = idle ? "unref" : "ref";
    child[method]();
    child.channel?.[method]?.();
    for (const stream of [child.stdout, child.stderr]) {
      if (stream instanceof Socket) {
        stream[method]();
      }
    }
  };
  let retired = false;
  let sequence = 0;
  let pendingOperation: Promise<SqliteReadOnlyWorkerValue> | undefined;
  let stderr = "";
  let outputBytes = 0;
  let pending:
    | {
        id: number;
        mode: SqliteReadOnlyWorkerMode;
        resolve: (value: SqliteReadOnlyWorkerValue) => void;
        reject: (error: unknown) => void;
        cleanup: () => void;
        failure?: unknown;
        transfer?:
          | ReturnType<typeof createSqliteAuthTransferReceiver>
          | ReturnType<typeof createSqliteOperationTransferReceiver>;
      }
    | undefined;
  const { promise: closeSignal, resolve: resolveClosed } = createDeferredCore();
  const authReaderResources = new Map<string, () => void>();
  // Broker loss retains group cleanup later in the same turn as proxy close.
  const closed = closeSignal.then(async () => {
    if (
      transport.kind === "broker" &&
      child instanceof BrokerChild &&
      !child.notStarted &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      await transport.owner.waitForCleanup();
    }
    for (const unregister of authReaderResources.values()) {
      unregister();
    }
    authReaderResources.clear();
  });
  const retire = (error?: unknown) => {
    setIdle(false);
    retired = true;
    if (pending && error !== undefined) {
      pending.failure ??= error;
    }
    child.kill("SIGKILL");
  };
  const sendMessage = (message: Parameters<ChildProcess["send"]>[0]) =>
    child.send(message, (error) => {
      if (error) {
        retire(error);
      }
    });
  const releasePending = (request: NonNullable<typeof pending>) => {
    pending = undefined;
    pendingOperation = undefined;
    request.cleanup();
    if (host.pooledRead) {
      for (const unregister of authReaderResources.values()) {
        unregister();
      }
      authReaderResources.clear();
    }
    return request;
  };
  if (host.retainLifetime !== false) {
    void retainSnapshotWork(closed, () => retire(new Error("SQLite snapshot owner stopped")));
  }
  let spawned = false;
  let nativeClosed = false;
  child.once("spawn", () => {
    spawned = true;
  });
  child.on("error", (error: NodeJS.ErrnoException) =>
    retire(
      spawned
        ? error
        : Object.assign(
            new Error(
              [
                ["EACCES", "ENOENT", "EPERM"].includes(error.code ?? "")
                  ? `SQLite read-only worker runtime binary not executable: ${executable} (${error.code}, cwd ${cwd}). Check runtime execute permissions and access to the working directory`
                  : `SQLite read-only worker failed to start (executable ${executable}, cwd ${cwd})`,
                error.message,
              ].join(": "),
              { cause: error },
            ),
            { code: error.code },
          ),
    ),
  );
  child.once("close", (code, signal) => {
    nativeClosed = true;
    retired = true;
    if (pending) {
      const request = releasePending(pending);
      request.reject(
        request.failure ??
          createSqliteReadOnlyWorkerError(
            `exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
            stderr,
          ),
      );
    }
    resolveClosed();
  });
  const captureOutput = (data: Buffer, isStderr: boolean) => {
    outputBytes += data.length;
    if (isStderr) {
      stderr = sliceUtf16Safe(stderr + data.toString("utf8"), -SQLITE_READONLY_STDERR_TAIL_CHARS);
    }
    if (outputBytes > SQLITE_READONLY_WORKER_MAX_BUFFER) {
      retire(createSqliteReadOnlyWorkerError("exceeded its output buffer", stderr));
    }
  };
  const attachOutput = () => {
    child.stdout?.on("data", (data: Buffer) => captureOutput(data, false));
    child.stderr?.on("data", (data: Buffer) => captureOutput(data, true));
  };
  // The broker publishes IPC connectivity and transferred pipes asynchronously.
  const ready =
    child instanceof BrokerChild ? child.ready().then(attachOutput).catch(retire) : undefined;
  if (!ready) {
    attachOutput();
  }
  child.on("message", (message: unknown) => {
    if (retired) {
      return;
    }
    if (
      !pending ||
      !message ||
      typeof message !== "object" ||
      Object.keys(message).length !== 2 ||
      !("id" in message) ||
      message.id !== pending.id ||
      !("result" in message)
    ) {
      retire(createSqliteReadOnlyWorkerError("returned an unexpected response", stderr));
      return;
    }
    try {
      let value: SqliteReadOnlyWorkerValue;
      if (
        pending.transfer &&
        !(
          typeof message.result === "object" &&
          message.result !== null &&
          "ok" in message.result &&
          message.result.ok === false
        )
      ) {
        const reply = pending.transfer.accept(message.result);
        if ("request" in reply) {
          sendMessage({ id: pending.id, transfer: reply.request });
          return;
        }
        value = reply.value;
      } else {
        value = readSqliteReadOnlyWorkerValue(
          { kind: "launched", stdout: JSON.stringify(message.result), stderr, status: 0 },
          pending.mode,
        );
      }
      releasePending(pending).resolve(value);
    } catch (error) {
      if (
        pending &&
        host.retainOnOperationError &&
        isSqliteSnapshotStagingMode(pending.mode) &&
        isSqliteReadOnlyWorkerResult(message.result) &&
        !message.result.ok
      ) {
        releasePending(pending).reject(error);
        return;
      }
      // A failed native close can retain a source lease. Do not reject the
      // request (and let its staging directory disappear) until process close.
      retire(error);
    }
  });
  const session: SqliteReadOnlyWorkerSession = {
    closed,
    isRetired() {
      return retired;
    },
    get notStarted() {
      return child instanceof BrokerChild ? child.notStarted : nativeClosed && !spawned;
    },
    createNativeReplacement() {
      return runInDetachedAsyncContext(() =>
        createSqliteReadOnlyWorkerSession({
          ...host,
          env,
          cwd,
          argv,
          transport: { kind: "native" },
        }),
      );
    },
    compatible(launch: SqliteReadOnlyWorkerLaunch) {
      return !retired && isSameSqliteReadOnlyWorkerLaunch(capturedLaunch, launch);
    },
    run(pathname: string, options: SqliteReadOnlyWorkerOptions) {
      if (retired) {
        return Promise.reject(new Error("SQLite read-only worker is closed"));
      }
      if (
        options.mode === "auth-profile-rows" &&
        options.source === "canonical" &&
        !options.artifactPreserving
      ) {
        const databasePath = path.resolve(pathname);
        if (!authReaderResources.has(databasePath)) {
          authReaderResources.set(
            databasePath,
            registerOpenClawAgentDatabaseReadCandidateResource({
              path: databasePath,
              revoke: () => retire(new Error("Auth profile reader owner was revoked")),
              close: () => session.close(),
            }),
          );
        }
      }
      return (pendingOperation = new Promise<SqliteReadOnlyWorkerValue>((resolve, reject) => {
        const { timeoutMs, size } = host.readBudget(pathname);
        stderr = "";
        outputBytes = 0;
        const abort = () => retire(options.signal?.reason);
        const timer = host.deadlineOwnedByCaller()
          ? undefined
          : setTimeout(() => retire(host.timeoutError(pathname, timeoutMs, size)), timeoutMs);
        const id = ++sequence;
        pending = {
          id,
          mode: options.mode,
          ...(options.mode === "auth-profile-rows"
            ? { transfer: createSqliteAuthTransferReceiver() }
            : options.mode === "operation"
              ? { transfer: createSqliteOperationTransferReceiver(options.command.type) }
              : {}),
          resolve,
          reject,
          cleanup: () => {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
          },
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) {
          abort();
          return;
        }
        const send = () => {
          if (retired) {
            return;
          }
          try {
            const request = {
              id,
              args: host.requestArgs(pathname, options),
              ...(options.mode === "auth-profile-rows" || options.mode === "operation"
                ? {
                    [options.mode === "operation" ? "operation" : "auth"]: {
                      expectedIdentity: options.expectedIdentity,
                      artifactPreserving: options.artifactPreserving,
                      ...(options.mode === "operation"
                        ? { command: serialize(options.command).toString("base64") }
                        : {
                            retainReader:
                              !host.pooledRead &&
                              options.source === "canonical" &&
                              !options.artifactPreserving,
                            schema:
                              options.source === "canonical" && !options.artifactPreserving
                                ? captureSqliteAuthSchema(pathname, options.expectedIdentity)
                                : undefined,
                          }),
                    },
                  }
                : {}),
            };
            if (
              options.mode === "operation" &&
              Buffer.byteLength(JSON.stringify(request)) > SQLITE_READONLY_WORKER_MAX_BUFFER
            ) {
              throw new Error("SQLite read-only operation exceeded its request buffer");
            }
            sendMessage(request);
          } catch (error) {
            retire(error);
          }
        };
        if (ready) {
          void ready.then(send);
        } else {
          send();
        }
      }));
    },
    setIdle,
    async close() {
      session.setIdle(false);
      if (retired) {
        await closed;
        return;
      }
      retired = true;
      // An idle child may flush Node's compile cache before exiting. Retain the
      // inspection budget as a ceiling if shutdown does not finish normally.
      const timer = setTimeout(() => retire(), host.closeTimeoutMs);
      try {
        // Child-owned disconnect preserves Node's process-and-pipes close event.
        sendMessage("close");
      } catch (error) {
        retire(error);
      }
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  host.runtimeGeneration?.retain(session, async () => {
    await pendingOperation?.catch(() => undefined);
    return () => session.close();
  });
  return session;
}

const log = createSubsystemLogger("state/sqlite");

function trackSqliteRead(options: SqliteAuthProfileReadOptions | SqliteReadOnlyOperationOptions) {
  return trackWorkerRequest(
    "sqlite_read",
    classifyWorkerRequest(options.mode === "operation" ? options.command.type : options.mode),
    options.signal,
  );
}

export function createSqliteReadOnlyWorkerPool(
  createSession: (
    launch: SqliteReadOnlyWorkerLaunch & { pooledRead: true },
  ) => ReturnType<typeof createSqliteReadOnlyWorkerSession>,
) {
  // Process reuse is bounded independently of request scopes. Each slot serializes
  // its requests; cancellation retires only the active child, never another slot.
  const scopedReadWorkers: Array<{
    launch: SqliteReadOnlyWorkerLaunch;
    session?: ReturnType<typeof createSqliteReadOnlyWorkerSession>;
    tail: Promise<void>;
    queued: number;
    idle?: ReturnType<typeof setTimeout>;
    leased?: { started: boolean };
    quarantined?: { error: unknown };
  }> = [];
  const SCOPED_READ_WORKER_LIMIT = 4;
  const SCOPED_READ_WORKER_IDLE_MS = 60_000;
  const statefulReadWorkers = new WeakMap<
    SqliteReadOnlyWorkerScope,
    (typeof scopedReadWorkers)[number]
  >();
  const readWorkerReleaseWaiters = new Set<() => void>();

  async function closeSlot(slot: (typeof scopedReadWorkers)[number]) {
    const worker = slot.session;
    try {
      await worker?.close();
      slot.session = undefined;
    } catch (error) {
      // An unconfirmed native exit still occupies capacity, but must not poison
      // compatible reads that can use another healthy slot.
      slot.quarantined = { error };
      for (const released of readWorkerReleaseWaiters) {
        released();
      }
      throw error;
    }
  }

  async function selectScopedReadWorker(
    options: SqliteAuthProfileReadOptions | SqliteReadOnlyOperationOptions,
    launch: SqliteReadOnlyWorkerLaunch,
  ): Promise<(typeof scopedReadWorkers)[number]> {
    const stateful =
      options.mode === "operation" &&
      (options.command.type === "pageCache.begin" || options.command.type === "pageCache.step");
    const scope = readOnlyWorkerScope.getStore();
    if (stateful) {
      if (!scope?.active) {
        throw new Error("Database page-cache warm requires an active read-only worker scope");
      }
      const retained = statefulReadWorkers.get(scope);
      if (retained) {
        if (!isSameSqliteReadOnlyWorkerLaunch(retained.launch, launch)) {
          throw new Error("Database page-cache warm worker launch changed during its scope");
        }
        return retained;
      }
      if (options.command.type === "pageCache.step") {
        throw new Error("Database page-cache warm is no longer active");
      }
    }
    for (;;) {
      options.signal?.throwIfAborted();
      const available = scopedReadWorkers.filter(
        (candidate) => !candidate.leased && !candidate.quarantined,
      );
      let slot = available.find((candidate) =>
        isSameSqliteReadOnlyWorkerLaunch(candidate.launch, launch),
      );
      if (!slot && scopedReadWorkers.length < SCOPED_READ_WORKER_LIMIT) {
        slot = { launch, tail: Promise.resolve(), queued: 0 };
        scopedReadWorkers.push(slot);
      }
      slot ??= available.find((candidate) => candidate.queued === 0 && !candidate.session);
      slot ??= available.reduce<(typeof scopedReadWorkers)[number] | undefined>(
        (best, candidate) => (!best || candidate.queued < best.queued ? candidate : best),
        undefined,
      );
      if (slot) {
        if (stateful && scope) {
          const retained = slot;
          const lease = { started: false };
          retained.leased = lease;
          statefulReadWorkers.set(scope, retained);
          // Stateful iterators span requests; their scope joins native retirement
          // before making the slot available to another launch or caller.
          scope.releaseReadWorker = async () => {
            try {
              if (lease.started) {
                await retained.tail;
                await closeSlot(retained);
              }
            } finally {
              retained.leased = undefined;
              statefulReadWorkers.delete(scope);
              scope.releaseReadWorker = undefined;
              if (
                !retained.quarantined &&
                retained.queued === 0 &&
                retained.session &&
                !retained.session.isRetired()
              ) {
                retained.session.setIdle(true);
                armScopedReadWorkerIdle(retained);
              }
              for (const released of readWorkerReleaseWaiters) {
                released();
              }
            }
          };
        }
        return slot;
      }
      if (scopedReadWorkers.every((candidate) => candidate.quarantined)) {
        throw new AggregateError(
          scopedReadWorkers.map((candidate) => candidate.quarantined?.error),
          "SQLite read-only worker capacity is held by unconfirmed cleanup",
        );
      }
      let released!: () => void;
      const availableWorker = runInDetachedAsyncContext(
        () =>
          new Promise<void>((resolve) => {
            released = resolve;
          }),
      );
      readWorkerReleaseWaiters.add(released);
      try {
        await racePromiseWithAbortSignal(
          availableWorker,
          options.signal,
          (signal) => signal.reason,
        );
      } finally {
        readWorkerReleaseWaiters.delete(released);
      }
    }
  }

  function armScopedReadWorkerIdle(slot: (typeof scopedReadWorkers)[number]) {
    slot.idle = runInDetachedAsyncContext(() =>
      setTimeout(() => {
        // Leave the retiring session in the slot until its native close has joined.
        slot.tail = runInDetachedAsyncContext(() =>
          closeSlot(slot).then(
            () => {},
            () => {
              log.warn("Idle SQLite read-only worker cleanup failed");
            },
          ),
        );
      }, SCOPED_READ_WORKER_IDLE_MS),
    );
    slot.idle.unref();
  }

  return async function runSqliteScopedReadWorker(
    pathname: string,
    options: SqliteAuthProfileReadOptions | SqliteReadOnlyOperationOptions,
    launch: SqliteReadOnlyWorkerLaunch,
    observation = trackSqliteRead(options),
  ): Promise<SqliteReadOnlyWorkerValue> {
    const stateful =
      options.mode === "operation" &&
      (options.command.type === "pageCache.begin" || options.command.type === "pageCache.step");
    let selected: (typeof scopedReadWorkers)[number];
    try {
      selected = await selectScopedReadWorker(options, launch);
    } catch (error) {
      observation.completed();
      throw error;
    }
    clearTimeout(selected.idle);
    selected.queued++;
    const previous = selected.tail;
    const operation = runInDetachedAsyncContext(() =>
      racePromiseWithAbortSignal(previous, options.signal, (signal) => signal.reason),
    )
      .then(async () => {
        options.signal?.throwIfAborted();
        if (selected.quarantined) {
          throw selected.quarantined.error;
        }
        observation.started();
        if (
          selected.leased &&
          options.mode === "operation" &&
          options.command.type === "pageCache.begin"
        ) {
          selected.leased.started = true;
        }
        if (
          !isSameSqliteReadOnlyWorkerLaunch(selected.launch, launch) ||
          selected.session?.isRetired()
        ) {
          await closeSlot(selected);
        }
        options.signal?.throwIfAborted();
        selected.launch = launch;
        const worker = (selected.session ??= createSession({
          ...launch,
          pooledRead: true,
        }));
        worker.setIdle(false);
        try {
          const value = await worker.run(pathname, options);
          options.signal?.throwIfAborted();
          if (
            !stateful &&
            !getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources
          ) {
            await closeSlot(selected);
          }
          return value;
        } catch (error) {
          // Confirm native retirement before releasing a failed request's bytes.
          try {
            await closeSlot(selected);
          } catch (cleanupError) {
            throw createSqliteLifecycleAggregateError(
              [error, cleanupError],
              "SQLite read and child cleanup failed",
              error,
            );
          }
          throw error;
        }
      })
      .finally(() => {
        observation.completed();
        selected.queued--;
        if (
          !selected.leased &&
          !selected.quarantined &&
          selected.queued === 0 &&
          selected.session &&
          !selected.session.isRetired()
        ) {
          selected.session?.setIdle(true);
          armScopedReadWorkerIdle(selected);
        }
      });
    selected.tail = runInDetachedAsyncContext(() =>
      Promise.allSettled([previous, operation]).then(() => {}),
    );
    return operation;
  };
}
