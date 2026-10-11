import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { serialize } from "node:v8";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { BrokerChild } from "../process/spawn-broker/child.js";
import type { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { recordChildProcessSpawn } from "../process/spawn-diagnostics.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { tryProcessCwd } from "./safe-cwd.js";
import {
  createSqliteAuthTransferReceiver,
  createSqliteOperationTransferReceiver,
} from "./sqlite-readonly-auth-transfer.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import {
  createSqliteReadOnlyWorkerError,
  isSqliteReadOnlyWorkerResult,
  isSqliteSnapshotStagingMode,
  readSqliteReadOnlyWorkerValue,
  SQLITE_READONLY_STDERR_TAIL_CHARS,
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  type SqliteReadOnlyWorkerMode,
  type SqliteReadOnlyWorkerOptions,
  type SqliteReadOnlyWorkerValue,
} from "./sqlite-readonly-worker-protocol.js";

export type SqliteReadOnlyWorkerLaunch = {
  runtimeGeneration?: RuntimeWorkerGeneration;
  env: NodeJS.ProcessEnv;
  cwd: string;
  transport: { kind: "native" } | { kind: "broker"; owner: SpawnBrokerHost };
};

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

type SqliteReadOnlyWorkerSession = {
  readonly closed: Promise<void>;
  readonly notStarted: boolean;
  createNativeReplacement: () => SqliteReadOnlyWorkerSession;
  isRetired: () => boolean;
  compatible: (launch: SqliteReadOnlyWorkerLaunch) => boolean;
  run: (
    pathname: string,
    options: SqliteReadOnlyWorkerOptions,
  ) => Promise<SqliteReadOnlyWorkerValue>;
  close: () => Promise<void>;
};

export function createSqliteReadOnlyWorkerSession(
  host: SqliteReadOnlyWorkerLaunch & {
    retainLifetime?: boolean;
    retainOnOperationError?: boolean;
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
  recordChildProcessSpawn(executable, child);
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
  // Broker loss retains group cleanup later in the same turn as proxy close.
  const closed = closeSignal.then(() => {
    if (
      transport.kind === "broker" &&
      child instanceof BrokerChild &&
      !child.notStarted &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      return transport.owner.waitForCleanup();
    }
    return undefined;
  });
  const retire = (error?: unknown) => {
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
                        : {}),
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
    async close() {
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
