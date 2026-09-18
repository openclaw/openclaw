import { spawn } from "node:child_process";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSqliteAuthTransferReceiver } from "./sqlite-readonly-auth-transfer.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import {
  createSqliteReadOnlyWorkerError,
  readSqliteReadOnlyWorkerValue,
  SQLITE_READONLY_STDERR_TAIL_CHARS,
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  type SqliteReadOnlyWorkerMode,
  type SqliteReadOnlyWorkerOptions,
  type SqliteReadOnlyWorkerValue,
} from "./sqlite-readonly-worker-protocol.js";

export function createSqliteReadOnlyWorkerSession(host: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  argv: string[];
  requestArgs: (pathname: string, options: SqliteReadOnlyWorkerOptions) => string[];
  readBudget: (pathname: string) => { timeoutMs: number; size: string };
  deadlineOwnedByCaller: () => boolean;
  timeoutError: (pathname: string, timeoutMs: number, size: string) => Error;
  closeTimeoutMs: number;
}) {
  const env = { ...host.env };
  const cwd = host.cwd;
  const child = spawn(process.execPath, host.argv, {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
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
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const retire = (error?: unknown) => {
    retired = true;
    if (pending && error !== undefined) {
      pending.failure ??= error;
    }
    child.kill("SIGKILL");
  };
  void retainSnapshotWork(closed, () => retire(new Error("SQLite snapshot owner stopped")));
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
  child.stdout?.on("data", (data: Buffer) => captureOutput(data, false));
  child.stderr?.on("data", (data: Buffer) => captureOutput(data, true));
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
      // A failed native close can retain a source lease. Do not reject the
      // request (and let its staging directory disappear) until process close.
      retire(error);
    }
  });
  return {
    compatible(launch: { env: NodeJS.ProcessEnv; cwd: string }) {
      const keys = Object.keys(launch.env);
      return (
        !retired &&
        launch.cwd === cwd &&
        keys.length === Object.keys(env).length &&
        keys.every((key) => launch.env[key] === env[key])
      );
    },
    run(pathname: string, options: SqliteReadOnlyWorkerOptions) {
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
