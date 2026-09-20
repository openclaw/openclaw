import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { BrokerChild } from "../process/spawn-broker/child.js";
import type { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { createSqliteAuthTransferReceiver } from "./sqlite-readonly-auth-transfer.js";
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
  const transport: SqliteReadOnlyWorkerLaunch["transport"] =
    host.transport.kind === "broker"
      ? { kind: "broker", owner: host.transport.owner }
      : { kind: "native" };
  const capturedLaunch = { env, cwd, transport };
  const argv = [...host.argv];
  const spawnOptions: SpawnOptions = {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  };
  const child: ChildProcess =
    transport.kind === "broker"
      ? transport.owner.spawn(process.execPath, argv, spawnOptions)
      : spawn(process.execPath, argv, spawnOptions);
  let retired = false;
  let sequence = 0;
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
        auth?: ReturnType<typeof createSqliteAuthTransferReceiver>;
      }
    | undefined;
  let resolveClosed: () => void;
  // Broker loss retains group cleanup later in the same turn as proxy close.
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  }).then(() => {
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
  if (host.retainLifetime !== false) {
    void retainSnapshotWork(closed, () => retire(new Error("SQLite snapshot owner stopped")));
  }
  child.on("error", (error) => retire(error));
  child.once("close", (code, signal) => {
    retired = true;
    if (pending) {
      const request = pending;
      pending = undefined;
      request.cleanup();
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
        pending.auth &&
        !(
          typeof message.result === "object" &&
          message.result !== null &&
          "ok" in message.result &&
          message.result.ok === false
        )
      ) {
        const reply = pending.auth.accept(message.result);
        if ("request" in reply) {
          child.send({ id: pending.id, transfer: reply.request }, (error) => {
            if (error) {
              retire(error);
            }
          });
          return;
        }
        value = reply.rows;
      } else {
        value = readSqliteReadOnlyWorkerValue(
          { stdout: JSON.stringify(message.result), stderr },
          pending.mode,
        );
      }
      const request = pending;
      pending = undefined;
      request.cleanup();
      request.resolve(value);
    } catch (error) {
      if (
        pending &&
        host.retainOnOperationError &&
        isSqliteSnapshotStagingMode(pending.mode) &&
        isSqliteReadOnlyWorkerResult(message.result) &&
        !message.result.ok
      ) {
        const request = pending;
        pending = undefined;
        request.cleanup();
        request.reject(error);
        return;
      }
      // A failed native close can retain a source lease. Do not reject the
      // request (and let its staging directory disappear) until process close.
      retire(error);
    }
  });
  return {
    isRetired() {
      return retired;
    },
    get notStarted() {
      return child instanceof BrokerChild && child.notStarted;
    },
    createNativeReplacement() {
      return createSqliteReadOnlyWorkerSession({
        ...host,
        env,
        cwd,
        argv,
        transport: { kind: "native" },
      });
    },
    compatible(launch: SqliteReadOnlyWorkerLaunch) {
      return !retired && isSameSqliteReadOnlyWorkerLaunch(capturedLaunch, launch);
    },
    run(pathname: string, options: SqliteReadOnlyWorkerOptions) {
      if (retired) {
        return Promise.reject(new Error("SQLite read-only worker is closed"));
      }
      return new Promise<SqliteReadOnlyWorkerValue>((resolve, reject) => {
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
            ? { auth: createSqliteAuthTransferReceiver() }
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
            child.send(
              {
                id,
                args: host.requestArgs(pathname, options),
                ...(options.mode === "auth-profile-rows"
                  ? {
                      auth: {
                        expectedIdentity: options.expectedIdentity,
                        coordinatorRuntime: options.coordinatorRuntime,
                      },
                    }
                  : {}),
              },
              (error) => {
                if (error) {
                  retire(error);
                }
              },
            );
          } catch (error) {
            retire(error);
          }
        };
        if (ready) {
          void ready.then(send);
        } else {
          send();
        }
      });
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
        child.send("close", (error) => {
          if (error) {
            retire(error);
          }
        });
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
}
